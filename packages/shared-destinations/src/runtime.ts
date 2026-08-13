/**
 * Destination consumer runtime.
 *
 * Per `docs/architecture/06-destinations.md`, the destination pipeline is:
 *
 *   analytics.events -> subscribe -> NORMALIZE -> MAP -> DELIVER -> RECORD
 *
 * This module owns everything between `subscribe` and `RECORD` for any
 * vendor consumer. Each vendor's `consumers/<vendor>/v<N>/` directory
 * supplies the vendor-specific MAP and DELIVER stages through the
 * `DestinationDescriptor` contract; the runtime supplies the rest:
 *
 *   1. **Subscribe** — a `PolarisConsumer` reads `analytics.events` (the
 *      runtime does not own the consumer's lifecycle; the host's `app.ts`
 *      builds one and hands it in).
 *
 *   2. **Per message:**
 *      - extract the replay context from headers; suppress if not allowed,
 *      - resolve the fan-out targets: every ACTIVE destination instance
 *        of this vendor in the envelope's environment, or the single
 *        instance pinned by a `polaris-destination-id` header (replay),
 *      - then, for each target:
 *      - read the destination instance from the cache (PostgreSQL on miss),
 *      - drop if the instance status is not `active`,
 *      - drop if the mode is `test` (no network delivery),
 *      - acquire the rate-limit lease,
 *      - decode the canonical envelope from the message value,
 *      - check destination-side dedupe (skip + log if already delivered),
 *      - call `normalizeForDestination` (P9-000),
 *      - on `drop` outcome -> record + return,
 *      - look up the per-event mapper -> `mapped_failed` if missing,
 *      - call the mapper -> `mapped_failed` on throw or `skip` outcome,
 *      - resolve the secret reference (one resolution per attempt),
 *      - call the deliverer with `(payload, instance, secret, ...)`,
 *      - on `accepted` outcome -> record + mark dedupe + return,
 *      - on `failed_retryable` outcome -> record + re-throw so KafkaJS
 *        retries; the host wraps this with DLQ routing when the attempt
 *        budget is exhausted,
 *      - on `failed_permanent` outcome -> record + publish to DLQ.
 *
 *   3. **Record** — a `delivery_records` row per outcome.
 *
 * The runtime is destination-AGNOSTIC. Vendor-specific code lives behind
 * the `DestinationDescriptor.mappers` and `DestinationDescriptor.deliverer`
 * slots; the runtime never imports anything vendor-shaped.
 *
 * Concurrency + RPS limits per `(destination_id, environment)` are honored
 * through `DestinationRateLimiter`. Secret resolution uses
 * `@polaris/shared-secrets`; resolved values live in memory for the
 * duration of one delivery attempt and are never persisted, logged, or
 * stamped onto delivery records.
 */

import {
  type NormalizableEnvelope,
  type NormalizedEvent,
  normalizeForDestination,
} from "@polaris/shared-destination-normalize";
import type { Logger } from "@polaris/shared-logger";
import { classifySecretFailure, type SecretResolver } from "@polaris/shared-secrets";

/**
 * The runtime's view of project configuration.
 *
 * Deliberately a one-method seam rather than the store itself: the runtime
 * needs a synchronous slice and nothing else, and depending on
 * `@polaris/shared-project-config` here would make every consumer that has
 * NOT cut over take that dependency too.
 */
export interface ProjectConfigLookup {
  /** Cache-only. Returns an empty object on a miss; never performs I/O. */
  valuesFor(projectId: string, environment: string): Readonly<Record<string, unknown>>;
}

/** Shared so a cold path does not allocate an object per delivery. */
const EMPTY_CONFIG: Readonly<Record<string, unknown>> = Object.freeze({});

import {
  consumerFamiliesFor,
  decodeEvent,
  type PolarisConsumer,
  type PolarisProducer,
  redeliverQueueName,
  STREAM_FAMILY_ANALYTICS_EVENTS,
  type StreamStartPosition,
  type TransportMessageHandler,
  type TransportMessagePayload,
} from "@polaris/shared-transport";

import {
  type DeliveryRecord,
  type DeliveryRecordErrorClass,
  type DeliveryRecordRepository,
  type DeliveryRecordStatus,
  truncateSummary,
} from "./db/delivery-records.js";
import type { DestinationInstance, DestinationInstanceReader } from "./db/destination-instance.js";
import type { DlqRecordRepository } from "./db/dlq-records.js";
import { type DestinationDedupe, InMemoryDestinationDedupe } from "./dedupe.js";
import { publishToDestinationDlq } from "./dlq.js";
import { buildDeliveryKey } from "./idempotency.js";
import { DestinationMetrics } from "./metrics.js";
import { DestinationRateLimiter } from "./rate-limiter.js";
import { applyReplayPolicy, readReplayContext } from "./replay-suppression.js";
import type {
  ConsumerIdentity,
  Deliverer,
  DelivererContext,
  DelivererResult,
  DestinationDescriptor,
  Mapper,
  MapperContext,
  MapperResult,
  RuntimeDropReason,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Options accepted by `createDestinationConsumer`.
 *
 * Most slots are mandatory because each represents a real subsystem the
 * runtime depends on; the few optional slots (`now`, `dedupe`,
 * `rateLimiter`, `logger`) accept sensible defaults so tests can wire up
 * a runtime with minimal setup.
 */
export interface DestinationConsumerOptions<Payload> {
  /** Static vendor + per-stage version descriptor. */
  readonly descriptor: DestinationDescriptor<Payload>;
  /** Connected PolarisConsumer for `analytics.events`. */
  readonly consumer: PolarisConsumer;
  /**
   * Connected PolarisProducer used to republish DLQ messages. The runtime
   * does not own its lifecycle.
   */
  readonly producer: PolarisProducer;
  /**
   * Destination instance reader. Production wires the Kysely-backed
   * adapter wrapped in `DestinationInstanceCache`; tests use the
   * in-memory adapter.
   */
  readonly instances: DestinationInstanceReader;
  /** Delivery records repository (in-memory or Kysely-backed). */
  readonly records: DeliveryRecordRepository;
  /**
   * Optional DLQ records repository. When supplied, the runtime persists
   * a `dlq_records` row alongside the Kafka DLQ publish so the
   * `polaris dlq list/show/retry/mark-resolved` commands can read the
   * triage queue from PostgreSQL.
   *
   * When omitted, the runtime publishes to Kafka only — preserves
   * backward compatibility for callers (and tests) that don't depend on
   * the Postgres-backed triage path.
   */
  readonly dlqRecords?: DlqRecordRepository;
  /** Secret resolver. The runtime calls `.resolve(instance.secret_ref)`. */
  readonly secrets: SecretResolver;
  /**
   * Per-`(project, environment)` configuration for this consumer's namespace.
   *
   * Optional, and absent means "every project uses the values this consumer
   * was constructed with" — which is exactly the behaviour before any cutover,
   * so a consumer that has not moved yet is unaffected by this existing.
   *
   * Read with `peek`, never `get`: delivery is a hot path and an inline
   * assembly would put a database round-trip, and possibly a secret
   * resolution, inside it (plan §4.5). A miss falls back to the deployment
   * default and schedules a refresh through the store's own machinery.
   */
  readonly projectConfig?: ProjectConfigLookup | undefined;
  /** Structured logger. */
  readonly logger: Logger;
  /**
   * Allow delivery of replay messages. Default `false`: the runtime
   * suppresses replay traffic per `docs/architecture/06-destinations.md`.
   * Operators flip this on via the replay tooling's explicit opt-in.
   */
  readonly allowReplay?: boolean;
  /** Override `Date.now()` / `() => new Date()` for deterministic tests. */
  readonly now?: () => Date;
  /**
   * Per-destination rate limiter. Defaults to a fresh `DestinationRateLimiter`.
   * Hosts that want to share a limiter across consumers pass one in.
   */
  readonly rateLimiter?: DestinationRateLimiter;
  /**
   * Destination-side dedupe window. Defaults to a fresh
   * `InMemoryDestinationDedupe`. Hosts that want a different window
   * (or a future Redis adapter) inject here.
   */
  readonly dedupe?: DestinationDedupe;
  /**
   * `DestinationMetrics` registry. Defaults to a fresh registry. Hosts
   * thread the registry through `app.ts` so the `/metrics` endpoint can
   * expose the samples.
   */
  readonly metrics?: DestinationMetrics;
  /**
   * Where to start when the consumer group has no checkpoint for a
   * stream. Defaults to `next` (only new traffic). Replay tooling sets
   * `first` and pairs it with the explicit `allowReplay` opt-in.
   *
   * Note this only applies on a cold start: once a checkpoint exists it
   * always wins, which is what stops a restart from replaying the whole
   * retention window into a live vendor account.
   */
  readonly startPosition?: StreamStartPosition;
  /**
   * Operational build version stamped on every `delivery_records` row
   * (M0DROHV3). Distinct from the descriptor's `consumerVersion`, which
   * is the semantic v1/v2/... contract. The build version is the runtime
   * instance — typically `releaseLabel || gitSha || serviceVersion` from
   * `getBuildMetadata()`. When omitted, the column is written as NULL.
   */
  readonly consumerBuildVersion?: string;
  /**
   * How long the per-environment list of active destination instances is
   * held before it is re-read from PostgreSQL. Defaults to 10_000 ms.
   *
   * The list drives the fan-out in the transport handler (see
   * `resolveFanoutTargets`), so it is consulted once per message and has
   * to be cached — but a long TTL is the wrong trade-off here. Unlike
   * `findById`, which the `DestinationInstanceCache` caches for 60s, this
   * list decides whether a brand-new destination receives traffic at all;
   * a shorter window keeps `polaris destinations create` feeling live
   * without adding a query per event.
   */
  readonly activeInstanceTtlMs?: number;
}

/** Runtime handle. The host's `app.ts` calls `start()` / `stop()`. */
export interface DestinationConsumer {
  /** Subscribe to `analytics.events` and start consuming. Idempotent. */
  start(): Promise<void>;
  /** Stop the underlying consumer. Idempotent. */
  stop(): Promise<void>;
  /** The per-message handler. Exposed for direct testing. */
  readonly handler: TransportMessageHandler;
  /** Process one envelope directly, bypassing KafkaJS. */
  readonly handleEvent: HandleEventFn;
  /** Metrics registry the runtime is wired to. */
  readonly metrics: DestinationMetrics;
  /** Rate limiter the runtime is wired to. */
  readonly rateLimiter: DestinationRateLimiter;
  /** Dedupe window the runtime is wired to. */
  readonly dedupe: DestinationDedupe;
}

/**
 * Direct-call entry point bypassing the Kafka consumer. Used by tests
 * and by replay tooling that wants to drive the runtime from an in-memory
 * envelope list rather than a topic. Returns the persisted
 * `DeliveryRecord` (or `null` when the runtime short-circuited before a
 * record was written, e.g. replay suppression).
 */
export type HandleEventFn = (input: HandleEventInput) => Promise<DeliveryRecord | null>;

/** Input accepted by `handleEvent`. */
export interface HandleEventInput {
  /** The canonical envelope from `analytics.events`. */
  readonly envelope: NormalizableEnvelope;
  /** The destination instance id the runtime should deliver to. */
  readonly destination_id: string;
  /**
   * Optional KafkaJS payload bytes. Tests that want the runtime to publish
   * to a DLQ on permanent failure pass one in; tests that only assert the
   * `delivery_records` row leave it undefined.
   */
  readonly payload?: TransportMessagePayload;
  /** Optional attempt counter override (default: 1). */
  readonly attempt?: number;
  /** Optional flag: treat this envelope as a replay. */
  readonly is_replay?: boolean;
}

/**
 * Build a destination consumer runtime around a `DestinationDescriptor`.
 *
 * The factory does not connect the consumer/producer; the host's
 * `app.ts` owns lifecycle wiring so the bootstrap can plumb connect into
 * the readiness probe and disconnect into the graceful-shutdown task list.
 */
export function createDestinationConsumer<Payload>(
  options: DestinationConsumerOptions<Payload>,
): DestinationConsumer {
  const now = options.now ?? (() => new Date());
  const rateLimiter = options.rateLimiter ?? new DestinationRateLimiter();
  const dedupe = options.dedupe ?? new InMemoryDestinationDedupe();
  const metrics = options.metrics ?? new DestinationMetrics();
  const allowReplay = options.allowReplay ?? false;
  const activeInstanceTtlMs = options.activeInstanceTtlMs ?? DEFAULT_ACTIVE_INSTANCE_TTL_MS;

  /**
   * Per-environment cache of active destination ids for this vendor.
   *
   * `DestinationInstanceReader.findActiveByVendor` is a table scan on
   * `(vendor, environment, status)`; the fan-out consults it once per
   * message, so it is cached behind a short TTL. Keyed by environment
   * because one consumer process serves whatever environments appear on
   * the stream, and each has its own destination rows.
   */
  const activeTargets = new Map<string, { ids: readonly string[]; expiresAt: number }>();

  async function resolveFanoutTargets(
    payload: TransportMessagePayload,
    envelope: NormalizableEnvelope,
  ): Promise<readonly string[]> {
    const pinned = readDestinationIdHeader(payload);
    if (pinned !== undefined) return [pinned];

    const environment = envelope.environment;
    const nowMs = now().getTime();
    const cached = activeTargets.get(environment);
    if (cached !== undefined && cached.expiresAt > nowMs) return cached.ids;

    const rows = await options.instances.findActiveByVendor(
      options.descriptor.identity.vendor,
      environment,
    );
    const ids = rows.map((row) => row.destination_id);
    activeTargets.set(environment, { ids, expiresAt: nowMs + activeInstanceTtlMs });
    return ids;
  }

  const handleEvent: HandleEventFn = async (input) => {
    return processOne({
      envelope: input.envelope,
      destination_id: input.destination_id,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      attempt: input.attempt ?? 1,
      is_replay: input.is_replay ?? false,
      descriptor: options.descriptor,
      instances: options.instances,
      records: options.records,
      ...(options.dlqRecords !== undefined ? { dlqRecords: options.dlqRecords } : {}),
      secrets: options.secrets,
      projectConfig: options.projectConfig,
      producer: options.producer,
      logger: options.logger,
      now,
      rateLimiter,
      dedupe,
      metrics,
      allowReplay,
      ...(options.consumerBuildVersion !== undefined
        ? { consumerBuildVersion: options.consumerBuildVersion }
        : {}),
    });
  };

  const handler: TransportMessageHandler = async (payload) => {
    // Skip empty/tombstone payloads. The runtime never produces an empty
    // delivery for them.
    const value = payload.message.value;
    if (value === null || value.length === 0) {
      options.logger.warn(
        {
          component: "destination.runtime",
          vendor: options.descriptor.identity.vendor,
          consumer_version: options.descriptor.identity.consumerVersion,
          topic: payload.stream,
          partition: payload.partition,
          offset: payload.message.offset,
        },
        "skipping empty/tombstone analytics event",
      );
      return;
    }

    // Decode the envelope here so the same envelope can be passed into
    // both replay-suppression accounting and dedupe / normalize.
    let decoded: unknown;
    try {
      decoded = decodeEvent(value);
    } catch (err) {
      options.logger.error(
        {
          component: "destination.runtime",
          vendor: options.descriptor.identity.vendor,
          consumer_version: options.descriptor.identity.consumerVersion,
          topic: payload.stream,
          partition: payload.partition,
          offset: payload.message.offset,
          err: errSummary(err),
        },
        "failed to decode analytics.events payload — DLQ-routing",
      );
      // Decode failure goes straight to the DLQ; nothing else can be
      // done with the bytes.
      await publishToDestinationDlq({
        producer: options.producer,
        identity: options.descriptor.identity,
        // No instance to look up — stamp a placeholder header so the DLQ
        // entry still carries the descriptor identity. Operators see the
        // missing destination id and triage from the headers.
        instance: PLACEHOLDER_INSTANCE,
        payload,
        reason: "decode_failed",
        error: err,
      });
      metrics.incrementDlq({
        vendor: options.descriptor.identity.vendor,
        consumer_version: options.descriptor.identity.consumerVersion,
        reason: "decode_failed",
      });
      return;
    }

    const envelope = decoded as NormalizableEnvelope;
    const replay = readReplayContext(payload.message.headers);

    // Which destination instances does this envelope go to?
    //
    // `analytics.events` is the shared canonical stream. Its producer
    // (analytics-projector) knows nothing about destinations — one
    // envelope is fanned out here, at the consumer, to every ACTIVE
    // instance of this consumer's vendor in the envelope's environment.
    //
    // A `polaris-destination-id` header overrides the fan-out and pins
    // the envelope to exactly one instance. That is the replay path:
    // `polaris replay` re-sends historical traffic to one named
    // destination, and must not splash it across every instance that
    // happens to be active now.
    const targets = await resolveFanoutTargets(payload, envelope);
    if (targets.length === 0) {
      // Not an error: a vendor with no destination rows for this
      // environment is the normal state of a consumer nobody has
      // enabled yet. Counted so "why is nothing arriving?" has an
      // answer on the /metrics endpoint.
      metrics.incrementSkipped({
        vendor: options.descriptor.identity.vendor,
        consumer_version: options.descriptor.identity.consumerVersion,
        project_id: envelope.project_id,
        environment: envelope.environment,
        reason: "no_active_destinations",
      });
      return;
    }

    // Fan out sequentially. A `failed_retryable` outcome re-throws out of
    // `processOne` so the transport redelivers the message — which
    // redelivers it for EVERY target, not just the one that failed. The
    // destination-side dedupe window (keyed by destination_id + delivery
    // key) is what keeps that from double-delivering to the targets that
    // already succeeded, so the first error is held back until every
    // target has had its turn rather than short-circuiting the loop.
    let retryable: unknown;
    let retryableSeen = false;
    for (const destination_id of targets) {
      try {
        await processOne({
          envelope,
          destination_id,
          payload,
          attempt: readAttemptHeader(payload),
          is_replay: replay.is_replay,
          descriptor: options.descriptor,
          instances: options.instances,
          records: options.records,
          ...(options.dlqRecords !== undefined ? { dlqRecords: options.dlqRecords } : {}),
          secrets: options.secrets,
          projectConfig: options.projectConfig,
          producer: options.producer,
          logger: options.logger,
          now,
          rateLimiter,
          dedupe,
          metrics,
          allowReplay,
          ...(options.consumerBuildVersion !== undefined
            ? { consumerBuildVersion: options.consumerBuildVersion }
            : {}),
        });
      } catch (err) {
        if (!retryableSeen) {
          retryable = err;
          retryableSeen = true;
        }
        options.logger.warn(
          {
            component: "destination.runtime",
            vendor: options.descriptor.identity.vendor,
            consumer_version: options.descriptor.identity.consumerVersion,
            destination_id,
            event_id: envelope.event_id,
            err: errSummary(err),
          },
          "destination delivery failed for one fan-out target — continuing with the rest",
        );
      }
    }
    if (retryableSeen) throw retryable;
  };

  let started = false;
  async function start(): Promise<void> {
    if (started) return;
    started = true;
    const families = consumerFamiliesFor(STREAM_FAMILY_ANALYTICS_EVENTS, []);
    // The redelivery queue carries messages the broker parked in a retry
    // tier and released when the tier's TTL expired. Consuming it here is
    // what makes the retry path close: under Kafka the consumer had to
    // sleep the backoff itself, which burned a consumer slot and made the
    // delay invisible to operators.
    // `component`, not `vendor`. The topology is declared from
    // POLARIS_COMPONENTS, so the queue is named for the component — and the
    // two strings are equal for every consumer except webhook-sink, whose
    // vendor is `webhook`. That one asked the broker for `webhook.redeliver`,
    // a queue provisioning has never declared, and died on boot with
    // NOT_FOUND while the other five worked by coincidence.
    const redeliver = redeliverQueueName(options.descriptor.identity.component);
    await options.consumer.subscribe({ families: [...families], queues: [redeliver] });
    options.logger.info(
      {
        component: "destination.runtime",
        vendor: options.descriptor.identity.vendor,
        topology_component: options.descriptor.identity.component,
        consumer_version: options.descriptor.identity.consumerVersion,
        families,
        redeliver_queue: redeliver,
      },
      "destination consumer subscribed to analytics.events",
    );
    await options.consumer.runEach(handler);
  }

  async function stop(): Promise<void> {
    if (!started) return;
    started = false;
    await options.consumer.disconnect();
  }

  return { start, stop, handler, handleEvent, metrics, rateLimiter, dedupe };
}

// ---------------------------------------------------------------------------
// Per-message pipeline
// ---------------------------------------------------------------------------

interface ProcessOneInput<Payload> {
  readonly envelope: NormalizableEnvelope;
  readonly destination_id: string;
  readonly payload?: TransportMessagePayload;
  readonly attempt: number;
  readonly is_replay: boolean;
  readonly descriptor: DestinationDescriptor<Payload>;
  readonly instances: DestinationInstanceReader;
  readonly records: DeliveryRecordRepository;
  readonly dlqRecords?: DlqRecordRepository;
  readonly secrets: SecretResolver;
  readonly projectConfig: ProjectConfigLookup | undefined;
  readonly producer: PolarisProducer;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly rateLimiter: DestinationRateLimiter;
  readonly dedupe: DestinationDedupe;
  readonly metrics: DestinationMetrics;
  readonly allowReplay: boolean;
  /** Forwarded onto every `delivery_records` row written this turn (M0DROHV3). */
  readonly consumerBuildVersion?: string;
}

async function processOne<Payload>(
  input: ProcessOneInput<Payload>,
): Promise<DeliveryRecord | null> {
  const {
    envelope,
    destination_id,
    payload,
    attempt,
    is_replay,
    descriptor,
    instances,
    records,
    dlqRecords,
    secrets,
    projectConfig,
    producer,
    logger,
    now,
    rateLimiter,
    dedupe,
    metrics,
    allowReplay,
    consumerBuildVersion,
  } = input;
  const identity = descriptor.identity;
  // Spread into every `recordOutcome` call so the column is stamped on
  // every row. `recordOutcome` only forwards it to `recordDelivery`
  // when defined, so omitting `consumerBuildVersion` keeps the column
  // NULL for callers that did not configure the build version.
  const outcomeBuildVersion = consumerBuildVersion !== undefined ? { consumerBuildVersion } : {};
  const baseLabels = {
    vendor: identity.vendor,
    consumer_version: identity.consumerVersion,
  };
  const startedAt = now();

  metrics.incrementConsumed({
    ...baseLabels,
    destination_id,
    project_id: envelope.project_id,
    environment: envelope.environment,
  });

  // 1. Resolve the destination instance.
  //
  // The instance is resolved BEFORE the replay-suppression check (P7-004)
  // because the suppression policy consults the per-instance
  // `replay_opt_in` column. A non-replay message still goes through the
  // same path; the cache lookup is the same hot-path call. The earlier
  // P9-001 ordering (suppress -> resolve) was kept while the host-level
  // `allowReplay` was the only gate; the per-instance gate forces the
  // resolve to happen first.
  //
  // For replay traffic targeting an UNKNOWN destination_id we treat it
  // the same way the original suppression path did: no delivery record,
  // structured log + metric, return. The lookup itself is bounded by
  // the cache, so the cost of resolving before the suppression check is
  // one cache hit per replayed message.
  const instance = await instances.findById(destination_id);
  if (instance === null) {
    if (is_replay) {
      metrics.incrementReplaySuppressed({
        ...baseLabels,
        destination_id,
        project_id: envelope.project_id,
        environment: envelope.environment,
      });
      logger.info(
        {
          component: "destination.runtime",
          ...baseLabels,
          destination_id,
          project_id: envelope.project_id,
          environment: envelope.environment,
          event_id: envelope.event_id,
          reason: "replay_disabled_instance",
        },
        "destination replay suppressed: unknown destination_id",
      );
    } else {
      logger.error(
        {
          component: "destination.runtime",
          ...baseLabels,
          destination_id,
          event_id: envelope.event_id,
        },
        "destination instance not found — skipping",
      );
    }
    // No delivery record; we have no destination row to FK against.
    return null;
  }

  const instanceLabels = {
    ...baseLabels,
    destination_id: instance.destination_id,
    project_id: envelope.project_id,
    environment: envelope.environment,
  };

  // 2. Replay suppression. Both the host-level `allowReplay` and the
  //    per-instance `replay_opt_in` column must be true for a replay
  //    message to advance. See P7-004 +
  //    `replay-suppression.ts` for the full contract.
  const replayDecision = applyReplayPolicy({
    context: { is_replay },
    allowHost: allowReplay,
    allowInstance: instance.replay_opt_in,
  });
  if (replayDecision.kind === "suppress") {
    metrics.incrementReplaySuppressed(instanceLabels);
    logger.info(
      {
        component: "destination.runtime",
        ...instanceLabels,
        event_id: envelope.event_id,
        reason: replayDecision.reason,
      },
      "destination replay suppressed",
    );
    // No delivery record on suppression — the replay was intentionally
    // dropped before the runtime touched the dedupe / normalize / map /
    // deliver stages. Operators see the metric and the structured log
    // line; the audit history for the destination's opt-in state lives
    // in `audit_records`.
    return null;
  }

  if (instance.status !== "active") {
    logger.info(
      {
        component: "destination.runtime",
        ...instanceLabels,
        event_id: envelope.event_id,
        status: instance.status,
      },
      "destination instance not active — skipping",
    );
    return null;
  }

  if (instance.mode === "test") {
    // Test mode = no network delivery. The runtime still records a
    // delivery row so smoke tests / smoke harness can assert end-to-end
    // shape, but it short-circuits before mapping / delivering.
    return recordOutcome({
      ...outcomeBuildVersion,
      records,
      metrics,
      logger,
      identity,
      instance,
      envelope,
      attempt,
      startedAt,
      now,
      status: "accepted",
      error_class: null,
      vendor_response_code: "test_mode",
      vendor_response_summary: "test_mode: no network delivery",
      dedupe_key: null,
      delivery_key: buildDeliveryKey({
        destination_id: instance.destination_id,
        event_id: envelope.event_id,
        identity,
      }),
      logLine: "destination instance in test mode — recorded skip",
      labels: instanceLabels,
    });
  }

  // 3. Destination-side dedupe.
  const delivery_key = buildDeliveryKey({
    destination_id: instance.destination_id,
    event_id: envelope.event_id,
    identity,
  });
  const dedupedAt = await dedupe.seen(instance.destination_id, delivery_key);
  if (dedupedAt !== undefined) {
    metrics.incrementDeduped(instanceLabels);
    logger.info(
      {
        component: "destination.runtime",
        ...instanceLabels,
        event_id: envelope.event_id,
        delivery_key,
        previously_delivered_at: new Date(dedupedAt).toISOString(),
      },
      "destination dedupe window already saw this event — skipping",
    );
    return null;
  }

  // 4. Normalize.
  const normalizeOutcome = normalizeForDestination(envelope, {
    destinationId: instance.destination_id,
    requiredConsent: descriptor.requiredConsent,
    ...(descriptor.identityHashing !== undefined
      ? { identityHashing: descriptor.identityHashing }
      : {}),
    ...(descriptor.identityFromProperties !== undefined
      ? { identityFromProperties: descriptor.identityFromProperties }
      : {}),
  });
  if (normalizeOutcome.kind === "drop") {
    return recordDrop({
      records,
      metrics,
      logger,
      identity,
      instance,
      envelope,
      attempt,
      startedAt,
      now,
      reason: normalizeOutcome.reason,
      detail: normalizeOutcome.detail,
      delivery_key,
      labels: instanceLabels,
    });
  }

  const normalized: NormalizedEvent = normalizeOutcome.normalized;

  // 5. Map.
  const mapper: Mapper<Payload> | undefined = descriptor.mappers[normalized.event];
  if (mapper === undefined) {
    return recordOutcome({
      ...outcomeBuildVersion,
      records,
      metrics,
      logger,
      identity,
      instance,
      envelope,
      attempt,
      startedAt,
      now,
      status: "mapped_failed",
      error_class: "mapping",
      vendor_response_code: null,
      vendor_response_summary: `no mapper for event '${normalized.event}'`,
      dedupe_key: null,
      delivery_key,
      logLine: "no mapper registered for event — mapped_failed",
      labels: instanceLabels,
    });
  }

  let mapResult: MapperResult<Payload>;
  const mapperContext: MapperContext = { normalized, instance };
  try {
    mapResult = mapper(mapperContext);
  } catch (err) {
    return recordOutcome({
      ...outcomeBuildVersion,
      records,
      metrics,
      logger,
      identity,
      instance,
      envelope,
      attempt,
      startedAt,
      now,
      status: "mapped_failed",
      error_class: "mapping",
      vendor_response_code: null,
      vendor_response_summary: truncateSummary(errSummaryString(err)),
      dedupe_key: null,
      delivery_key,
      logLine: "mapper threw — mapped_failed",
      labels: instanceLabels,
      logErr: err,
    });
  }

  if (mapResult.kind === "skip") {
    metrics.incrementSkipped({ ...instanceLabels, reason: mapResult.reason });
    return recordOutcome({
      ...outcomeBuildVersion,
      records,
      metrics,
      logger,
      identity,
      instance,
      envelope,
      attempt,
      startedAt,
      now,
      status: "mapped_failed",
      error_class: "mapping",
      vendor_response_code: null,
      vendor_response_summary: truncateSummary(`skip: ${mapResult.reason}`),
      dedupe_key: null,
      delivery_key,
      logLine: "mapper returned skip — mapped_failed",
      labels: instanceLabels,
      // The metric was already incremented above; the recordOutcome path
      // skips counting again because `status==='mapped_failed'`.
      suppressMetric: true,
    });
  }

  const vendor_dedupe_key = mapResult.dedupe_key ?? null;

  // 6. Resolve secret. The plaintext lives in memory for the duration of
  // this call ONLY. The reference (`provider:ref` form) is what gets
  // logged.
  let secret: string;
  try {
    secret = await secrets.resolve(instance.secret_ref);
  } catch (err) {
    // Not every secret failure is the operator's fault. A reference nobody
    // provisioned is permanent and belongs in the DLQ; a provider that was
    // briefly unreachable is not, and treating it as permanent destroyed
    // deliveries a retry seconds later would have completed — each one then
    // needing a human to notice and replay it.
    const failureClass = classifySecretFailure(err);
    const summary = truncateSummary(
      `secret resolution failed for ${instance.secret_ref}: ${errSummaryString(err)}`,
    );

    if (failureClass === "transient") {
      return recordOutcome({
        ...outcomeBuildVersion,
        records,
        metrics,
        logger,
        identity,
        instance,
        envelope,
        attempt,
        startedAt,
        now,
        status: "failed_retryable",
        error_class: "transient",
        vendor_response_code: null,
        vendor_response_summary: summary,
        dedupe_key: vendor_dedupe_key,
        delivery_key,
        logLine: "secret resolution failed — failed_retryable",
        labels: instanceLabels,
        logErr: err,
        // Re-throw through the same path a retryable delivery takes, so
        // KafkaJS retry semantics apply unchanged.
        rethrow: buildRetryableError({ error_class: "transient" }),
        // And the same exhaustion rule: once the attempt counter reaches the
        // destination's threshold, this still reaches the DLQ — just after the
        // provider was given a chance to come back.
        ...(attempt >= instance.dead_letter_threshold && payload !== undefined
          ? { payloadForDlq: payload }
          : {}),
        producer,
        ...(dlqRecords !== undefined ? { dlqRecords } : {}),
      });
    }

    return recordOutcome({
      ...outcomeBuildVersion,
      records,
      metrics,
      logger,
      identity,
      instance,
      envelope,
      attempt,
      startedAt,
      now,
      status: "failed_permanent",
      error_class: "auth",
      vendor_response_code: null,
      vendor_response_summary: summary,
      dedupe_key: vendor_dedupe_key,
      delivery_key,
      logLine: "secret resolution failed — failed_permanent",
      labels: instanceLabels,
      logErr: err,
      // Permanent failures publish to DLQ.
      ...(payload !== undefined ? { payloadForDlq: payload } : {}),
      producer,
      ...(dlqRecords !== undefined ? { dlqRecords } : {}),
    });
  }

  // 7. Rate limit + deliver.
  const lease = await rateLimiter.acquire(instance);
  metrics.observeRateLimitWaitMs(instanceLabels, lease.waited_ms);

  let deliveryResult: DelivererResult;
  const deliveryStartedAt = now();
  try {
    deliveryResult = await invokeDeliverer<Payload>({
      deliverer: descriptor.deliverer,
      context: {
        payload: mapResult.payload,
        instance,
        secret,
        ...(vendor_dedupe_key !== null ? { dedupe_key: vendor_dedupe_key } : {}),
        attempt,
        delivery_key,
        // Empty when no store is wired or the scope is cold. Deliverers fall
        // back to their constructed defaults, which is what the migrated
        // environment variable meant.
        projectConfig:
          projectConfig?.valuesFor(envelope.project_id, envelope.environment) ?? EMPTY_CONFIG,
      },
    });
  } catch (err) {
    // A throw from the deliverer is treated as `failed_retryable` with
    // `error_class='transient'` — deliverers SHOULD catch and return
    // a typed result, so a thrown error is most often a programmer bug
    // or a genuinely unexpected exception.
    lease.release();
    return recordOutcome({
      ...outcomeBuildVersion,
      records,
      metrics,
      logger,
      identity,
      instance,
      envelope,
      attempt,
      startedAt,
      now,
      status: "failed_retryable",
      error_class: "transient",
      vendor_response_code: null,
      vendor_response_summary: truncateSummary(errSummaryString(err)),
      dedupe_key: vendor_dedupe_key,
      delivery_key,
      logLine: "deliverer threw — failed_retryable",
      labels: instanceLabels,
      logErr: err,
      rethrow: err,
    });
  }
  const deliveryFinishedAt = now();
  metrics.observeDeliveryDurationMs(
    instanceLabels,
    deliveryFinishedAt.getTime() - deliveryStartedAt.getTime(),
  );
  lease.release();
  // Free the plaintext secret as soon as we're done — V8 won't zero the
  // backing buffer immediately, but releasing the local reference is the
  // best we can do in v1.
  secret = "";

  if (deliveryResult.kind === "accepted") {
    await dedupe.mark(instance.destination_id, delivery_key, deliveryFinishedAt.getTime());
    return recordOutcome({
      ...outcomeBuildVersion,
      records,
      metrics,
      logger,
      identity,
      instance,
      envelope,
      attempt,
      startedAt,
      now,
      status: "accepted",
      error_class: null,
      vendor_response_code: deliveryResult.vendor_response_code ?? null,
      vendor_response_summary: truncateSummary(deliveryResult.vendor_response_summary ?? null),
      dedupe_key: vendor_dedupe_key,
      delivery_key,
      logLine: "destination delivery accepted",
      labels: instanceLabels,
    });
  }

  if (deliveryResult.kind === "failed_retryable") {
    return recordOutcome({
      ...outcomeBuildVersion,
      records,
      metrics,
      logger,
      identity,
      instance,
      envelope,
      attempt,
      startedAt,
      now,
      status: "failed_retryable",
      error_class: deliveryResult.error_class,
      vendor_response_code: deliveryResult.vendor_response_code ?? null,
      vendor_response_summary: truncateSummary(deliveryResult.vendor_response_summary ?? null),
      dedupe_key: vendor_dedupe_key,
      delivery_key,
      logLine: "destination delivery failed_retryable",
      labels: instanceLabels,
      // Retryable failures re-throw so KafkaJS surfaces the error through
      // its own retry semantics. The host may also republish to a retry
      // topic when KafkaJS' retry budget is exhausted.
      rethrow: buildRetryableError(deliveryResult),
      // When the attempt counter is at-or-above the destination's
      // dead-letter threshold, also publish to the DLQ.
      ...(attempt >= instance.dead_letter_threshold && payload !== undefined
        ? { payloadForDlq: payload }
        : {}),
      producer,
      ...(dlqRecords !== undefined ? { dlqRecords } : {}),
    });
  }

  // failed_permanent
  return recordOutcome({
    ...outcomeBuildVersion,
    records,
    metrics,
    logger,
    identity,
    instance,
    envelope,
    attempt,
    startedAt,
    now,
    status: "failed_permanent",
    error_class: deliveryResult.error_class,
    vendor_response_code: deliveryResult.vendor_response_code ?? null,
    vendor_response_summary: truncateSummary(deliveryResult.vendor_response_summary ?? null),
    dedupe_key: vendor_dedupe_key,
    delivery_key,
    logLine: "destination delivery failed_permanent",
    labels: instanceLabels,
    ...(payload !== undefined ? { payloadForDlq: payload } : {}),
    producer,
    ...(dlqRecords !== undefined ? { dlqRecords } : {}),
  });
}

// ---------------------------------------------------------------------------
// Outcome recorders
// ---------------------------------------------------------------------------

interface RecordOutcomeInput {
  readonly records: DeliveryRecordRepository;
  readonly metrics: DestinationMetrics;
  readonly logger: Logger;
  readonly identity: ConsumerIdentity;
  readonly instance: DestinationInstance;
  readonly envelope: NormalizableEnvelope;
  readonly attempt: number;
  readonly startedAt: Date;
  readonly now: () => Date;
  readonly status: DeliveryRecordStatus;
  readonly error_class: DeliveryRecordErrorClass | null;
  readonly vendor_response_code: string | null;
  readonly vendor_response_summary: string | null;
  readonly dedupe_key: string | null;
  readonly delivery_key: string;
  readonly logLine: string;
  readonly labels: {
    readonly vendor: string;
    readonly consumer_version: string;
    readonly destination_id: string;
    readonly project_id: string;
    readonly environment: string;
  };
  readonly logErr?: unknown;
  /** Operational build version (M0DROHV3) stamped on the row. Forwarded by the runtime from `DestinationConsumerOptions.consumerBuildVersion`. */
  readonly consumerBuildVersion?: string;
  /** When set, the runtime publishes the original payload to the DLQ. */
  readonly payloadForDlq?: TransportMessagePayload;
  /** PolarisProducer required when `payloadForDlq` is set. */
  readonly producer?: PolarisProducer;
  /**
   * Optional DLQ records repository — persists a `dlq_records` row
   * alongside the Kafka publish. When omitted, the Kafka publish still
   * occurs but the row is not written. The CLI's triage commands read
   * from this table.
   */
  readonly dlqRecords?: DlqRecordRepository;
  /** When set, the function rethrows this error after the record is written. */
  readonly rethrow?: unknown;
  /** Skip the per-status metric increment (used when the caller already counted). */
  readonly suppressMetric?: boolean;
}

async function recordOutcome(input: RecordOutcomeInput): Promise<DeliveryRecord> {
  const finishedAt = input.now();
  const record = await input.records.recordDelivery({
    destination_id: input.instance.destination_id,
    event_id: input.envelope.event_id,
    event_name: input.envelope.event,
    project_id: input.envelope.project_id,
    environment: input.envelope.environment,
    consumer_version: input.identity.consumerVersion,
    ...(input.consumerBuildVersion !== undefined
      ? { consumer_build_version: input.consumerBuildVersion }
      : {}),
    normalize_version: input.identity.normalizeVersion,
    mapper_version: input.identity.mapperVersion,
    deliverer_version: input.identity.delivererVersion,
    attempt: input.attempt,
    status: input.status,
    error_class: input.error_class,
    vendor_response_code: input.vendor_response_code,
    vendor_response_summary: input.vendor_response_summary,
    dedupe_key: input.dedupe_key,
    started_at: input.startedAt,
    finished_at: finishedAt,
  });

  if (input.suppressMetric !== true) {
    if (input.status === "accepted" || input.status === "delivered") {
      input.metrics.incrementDelivered(input.labels);
    } else if (input.status.startsWith("dropped_")) {
      input.metrics.incrementDropped({
        ...input.labels,
        ...(input.error_class !== null ? { reason: input.error_class } : {}),
      });
    } else {
      input.metrics.incrementFailed({
        ...input.labels,
        ...(input.error_class !== null ? { reason: input.error_class } : {}),
      });
    }
  }

  const baseLogFields = {
    component: "destination.runtime",
    ...input.labels,
    event_id: input.envelope.event_id,
    event: input.envelope.event,
    status: input.status,
    attempt: input.attempt,
    delivery_id: record.delivery_id,
    delivery_key: input.delivery_key,
    instance_label: input.instance.instance_label,
    secret_ref: input.instance.secret_ref,
    consumer_version: input.identity.consumerVersion,
    normalize_version: input.identity.normalizeVersion,
    mapper_version: input.identity.mapperVersion,
    deliverer_version: input.identity.delivererVersion,
  };
  const logFields = {
    ...baseLogFields,
    ...(input.error_class !== null ? { error_class: input.error_class } : {}),
    ...(input.vendor_response_code !== null
      ? { vendor_response_code: input.vendor_response_code }
      : {}),
    ...(input.logErr !== undefined ? { err: errSummary(input.logErr) } : {}),
  };
  if (input.status === "accepted" || input.status === "delivered") {
    input.logger.info(logFields, input.logLine);
  } else if (
    input.status === "failed_retryable" ||
    input.status === "failed_permanent" ||
    input.status === "mapped_failed"
  ) {
    input.logger.error(logFields, input.logLine);
  } else {
    input.logger.info(logFields, input.logLine);
  }

  // DLQ-publish if requested.
  if (input.payloadForDlq !== undefined && input.producer !== undefined) {
    const dlqReason =
      input.error_class ?? (input.status === "failed_permanent" ? "permanent" : "transient");
    await publishToDestinationDlq({
      producer: input.producer,
      identity: input.identity,
      instance: input.instance,
      payload: input.payloadForDlq,
      reason: dlqReason,
      error: input.logErr,
      attempts: input.attempt,
      delivery_key: input.delivery_key,
      envelope: input.envelope,
      ...(input.dlqRecords !== undefined ? { dlqRecords: input.dlqRecords } : {}),
      ...(input.vendor_response_code !== null
        ? { vendor_response_code: input.vendor_response_code }
        : {}),
      ...(input.vendor_response_summary !== null
        ? { vendor_response_summary: input.vendor_response_summary }
        : {}),
    });
    input.metrics.incrementDlq({
      ...input.labels,
      reason: dlqReason,
    });
  }

  if (input.rethrow !== undefined) {
    if (input.rethrow instanceof Error) throw input.rethrow;
    throw new Error(String(input.rethrow));
  }

  return record;
}

interface RecordDropInput {
  readonly records: DeliveryRecordRepository;
  readonly metrics: DestinationMetrics;
  readonly logger: Logger;
  readonly identity: ConsumerIdentity;
  readonly instance: DestinationInstance;
  readonly envelope: NormalizableEnvelope;
  readonly attempt: number;
  readonly startedAt: Date;
  readonly now: () => Date;
  readonly reason: RuntimeDropReason;
  readonly detail?: string | undefined;
  readonly delivery_key: string;
  readonly labels: {
    readonly vendor: string;
    readonly consumer_version: string;
    readonly destination_id: string;
    readonly project_id: string;
    readonly environment: string;
  };
}

async function recordDrop(input: RecordDropInput): Promise<DeliveryRecord> {
  const status: DeliveryRecordStatus = mapDropReasonToStatus(input.reason);
  const error_class: DeliveryRecordErrorClass = mapDropReasonToErrorClass(input.reason);
  return recordOutcome({
    records: input.records,
    metrics: input.metrics,
    logger: input.logger,
    identity: input.identity,
    instance: input.instance,
    envelope: input.envelope,
    attempt: input.attempt,
    startedAt: input.startedAt,
    now: input.now,
    status,
    error_class,
    vendor_response_code: null,
    vendor_response_summary: input.detail ?? null,
    dedupe_key: null,
    delivery_key: input.delivery_key,
    logLine: `destination drop: ${input.reason}`,
    labels: input.labels,
  });
}

function mapDropReasonToStatus(reason: RuntimeDropReason): DeliveryRecordStatus {
  switch (reason) {
    case "consent_not_granted":
      return "dropped_consent";
    case "no_usable_identity":
      return "dropped_no_identity";
    case "invalid_envelope":
    case "redacted_payload_empty":
      return "dropped_invalid";
  }
}

function mapDropReasonToErrorClass(reason: RuntimeDropReason): DeliveryRecordErrorClass {
  switch (reason) {
    case "consent_not_granted":
      return "consent";
    case "no_usable_identity":
      return "identity";
    case "invalid_envelope":
    case "redacted_payload_empty":
      return "policy";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface InvokeDelivererInput<Payload> {
  readonly deliverer: Deliverer<Payload>;
  readonly context: DelivererContext<Payload>;
}

async function invokeDeliverer<Payload>(
  input: InvokeDelivererInput<Payload>,
): Promise<DelivererResult> {
  return input.deliverer(input.context);
}

function readDestinationIdHeader(payload: TransportMessagePayload): string | undefined {
  const headers = payload.message.headers;
  if (headers === undefined) return undefined;
  const value = headers["polaris-destination-id"];
  if (value === undefined) return undefined;
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (value instanceof Buffer) {
    const str = value.toString("utf8");
    return str.length > 0 ? str : undefined;
  }
  if (Array.isArray(value)) {
    const first = value[0];
    if (first === undefined) return undefined;
    if (typeof first === "string") return first.length > 0 ? first : undefined;
    if (first instanceof Buffer) {
      const str = first.toString("utf8");
      return str.length > 0 ? str : undefined;
    }
  }
  return undefined;
}

function readAttemptHeader(payload: TransportMessagePayload): number {
  const headers = payload.message.headers;
  if (headers === undefined) return 1;
  const value = headers["polaris-retry-attempts"];
  if (value === undefined) return 1;
  let str: string | undefined;
  if (typeof value === "string") str = value;
  else if (value instanceof Buffer) str = value.toString("utf8");
  else if (Array.isArray(value)) {
    const first = value[0];
    if (typeof first === "string") str = first;
    else if (first instanceof Buffer) str = first.toString("utf8");
  }
  if (str === undefined) return 1;
  const parsed = Number.parseInt(str, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 1;
  return parsed + 1;
}

function buildRetryableError(result: { error_class: string }): Error {
  const err = new Error(`destination delivery failed_retryable: ${result.error_class}`);
  err.name = "DestinationRetryableError";
  return err;
}

function errSummary(err: unknown): { name?: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (typeof err === "string") return { message: err };
  return {};
}

function errSummaryString(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === "string") return err;
  return "unknown error";
}

/**
 * Default TTL for the per-environment active-destination list. Short
 * relative to the 60s `findById` cache because this list gates whether a
 * newly-created destination receives traffic at all.
 */
const DEFAULT_ACTIVE_INSTANCE_TTL_MS = 10_000;

/**
 * Placeholder destination instance used only for header stamping on DLQ
 * messages that we publish BEFORE resolving the real instance (decode
 * failures). The runtime never queries this object; it only feeds
 * headers that operators see during triage.
 */
const PLACEHOLDER_INSTANCE: DestinationInstance = {
  destination_id: "polaris_dst_unknown",
  project_id: "unknown",
  environment: "production",
  vendor: "unknown",
  instance_label: "unknown",
  secret_ref: "env:UNKNOWN",
  status: "active",
  mode: "live",
  max_concurrency: 1,
  max_rps: 1,
  retry_policy: "standard",
  dead_letter_threshold: 1,
  // Placeholder is opt-out: this row only stamps DLQ headers on
  // pre-resolve failures; it never goes through the replay gate.
  replay_opt_in: false,
};
