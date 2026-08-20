/**
 * Destination consumer runtime.
 *
 * Per `docs/architecture/06-destinations.md`, the destination pipeline is:
 *
 *   analytics.events -> subscribe -> NORMALIZE -> MAP -> DELIVER -> RECORD
 *
 * This module owns everything between `subscribe` and `RECORD` for any
 * vendor consumer. Each vendor's `sync/destinations/<vendor>/<version>/` directory
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
 *        of this vendor belonging to the envelope's PROJECT and
 *        environment, or the single instance pinned by a
 *        `polaris-destination-id` header (replay),
 *      - then, for each target:
 *      - read the destination instance from the cache (PostgreSQL on miss),
 *      - drop if the instance status is not `active`,
 *      - drop if the mode is `test` (no network delivery),
 *      - acquire the rate-limit lease,
 *      - decode the canonical envelope from the message value,
 *      - evaluate the routing GATE (subscriptions -> property filters ->
 *        instance consent) -> `skipped_filtered` if this instance was
 *        configured not to want the event,
 *      - check destination-side dedupe (skip + log if already delivered),
 *      - call `normalizeForDestination` (P9-000),
 *      - on `drop` outcome -> record + return,
 *      - look up the per-event mapper -> `skipped_unmapped` if missing,
 *      - call the mapper -> `mapped_failed` on throw or `skip` outcome,
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
 * through `DestinationRateLimiter`.
 *
 * The vendor credential arrives on the destination row as `secret_value` and
 * goes straight to the deliverer. There is no resolution step: the runtime
 * used to call `@polaris/shared-secrets` per attempt to turn a `provider:ref`
 * pointer into plaintext, which meant a delivery could fail because a secrets
 * provider was unreachable — a whole failure mode, with its own transient /
 * permanent classification, that reading a column does not have. The credential
 * is never persisted, logged, or stamped onto delivery records.
 */

import {
  type NormalizableEnvelope,
  type NormalizedEvent,
  normalizeForDestination,
} from "@polaris/shared-destination-normalize";
import type { Logger } from "@polaris/shared-logger";
import type { ProjectPolicyOverride } from "@polaris/shared-policy";

/**
 * The runtime's view of project configuration.
 *
 * Deliberately a one-method seam rather than the store itself: the runtime
 * needs a synchronous slice and nothing else, and depending on
 * `@polaris/shared-project-config` here would make every consumer that has
 * NOT cut over take that dependency too.
 */
export interface ProjectConfigLookup {
  /**
   * Cache-only. Returns empty values and a null version on a miss; never
   * performs I/O.
   *
   * ONE call returning both, deliberately. The routing gate reads the
   * values and the delivery row records the version, and a second read for
   * the version could straddle a config invalidation — leaving a row that
   * names a version which did not produce the decision it describes. That
   * is a worse failure than no version at all, because it looks like an
   * answer.
   */
  resolve(projectId: string, environment: string): ResolvedProjectConfig;
}

/** A project's config slice plus the version that produced it. */
export interface ResolvedProjectConfig {
  readonly values: Readonly<Record<string, unknown>>;
  /**
   * `project_config_versions.version`, stringified. `null` when no store
   * was consulted — a consumer running on deployment defaults has no
   * version to name, and NULL says exactly that.
   */
  readonly version: string | null;
}

/** Shared so a cold path does not allocate an object per delivery. */
const EMPTY_CONFIG: ResolvedProjectConfig = Object.freeze({
  values: Object.freeze({}),
  version: null,
});

import {
  type CanonicalStreamFamily,
  consumerFamiliesFor,
  decodeEvent,
  type IsolationSnapshot,
  type PolarisConsumer,
  type PolarisProducer,
  redeliverQueueName,
  republishToRetry,
  STREAM_FAMILY_RESOLVED_EVENTS,
  type StreamStartPosition,
  type TransportMessageHandler,
  type TransportMessagePayload,
} from "@polaris/shared-transport";
import { breakerKey, DestinationCircuitBreaker } from "./breaker.js";
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
import { evaluateGate, resolveRoutingGateConfig } from "./gate.js";
import { buildDeliveryKey } from "./idempotency.js";
import { DestinationMetrics } from "./metrics.js";
import { DestinationRateLimiter, type DestinationRateLimiterLike } from "./rate-limiter.js";
import { applyReplayPolicy, readReplayContext } from "./replay-suppression.js";
import { retryDelayMsFor } from "./retry-policy.js";
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
  /** Connected PolarisConsumer for the input family. */
  readonly consumer: PolarisConsumer;
  /**
   * Stream families this consumer reads. Defaults to `analytics.events`.
   *
   * The flip to `resolved.events` is per-vendor and staged, so this is an
   * option rather than a constant: a consumer that has moved reads the
   * spine's output with the profile and enrichment blocks populated, and
   * one that has not reads exactly what it read yesterday. Defaulting
   * rather than requiring it is what keeps the four unflipped vendors from
   * needing a change in the same commit as the first flipped one.
   *
   * ## Why a LIST is allowed
   *
   * A destination that receives audience membership — or any other
   * profile-plane fact — reads `profile.events` as well as the event
   * spine. Before this, `inputFamily` was a single family and no
   * destination could see the profile plane at all: `audience.entered`
   * and `profile.updated` were published, landed in ClickHouse, and
   * reached no vendor, which made the profile plane a warehouse feature
   * wearing an activation feature's name.
   *
   * A list rather than a second consumer because the two planes need
   * nothing different downstream. `normalizeForDestination` already reads
   * identity from the PROFILE block (`canonical_customer_id`, then
   * `profile_id`) as well as from `identity`; the gate, consent, dedupe,
   * delivery records and breaker are all keyed on the destination, not on
   * the family. A separate profile-plane consumer would have duplicated
   * every one of those to change which streams it subscribes to.
   *
   * Which EVENTS a vendor actually receives stays the routing gate's
   * decision, not this option's: subscribing to `profile.events` makes
   * `audience.entered` reachable, and the gate's `subscriptions` block is
   * what decides whether a given instance wants it.
   *
   * A single value stays accepted, so no unflipped consumer changes.
   */
  readonly inputFamily?: CanonicalStreamFamily | readonly CanonicalStreamFamily[] | undefined;
  /**
   * Isolation snapshot, so this consumer subscribes to isolated projects'
   * dedicated streams as well as the shared one.
   *
   * `consumerFamiliesFor(family, [])` was hardcoded here: a destination
   * subscribed only to the shared family, so once a project was isolated
   * its events landed on a dedicated stream that no destination read and
   * were never delivered anywhere. Every other consumer in the platform at
   * least ACCEPTED an isolated-projects list; this one did not have the
   * option.
   *
   * Optional because a test or a local run without a control plane should
   * still boot; absent, behaviour is what it was — shared only.
   */
  readonly isolation?: IsolationSnapshot | undefined;
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
  /**
   * `project_id` -> forbidden-field override, for the second-pass
   * redaction inside `normalizeForDestination`.
   *
   * The ingester applied the same override at intake. This is the
   * delivery-side half of the identical policy: a project override that
   * tightened between intake and now (or that was added to the registry
   * while events were already in the retention window) is enforced here
   * before anything reaches a vendor.
   *
   * The runtime does not read `definitions/policy` itself — a package that
   * loaded the registry could not be tested against a fixture override.
   * The host injects it, which is where the deploy-time default lives.
   * Absent means platform defaults for every project.
   */
  readonly projectPolicies?: ReadonlyMap<string, ProjectPolicyOverride> | undefined;
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
  readonly rateLimiter?: DestinationRateLimiterLike;
  /**
   * Per-instance circuit breaker. Defaults to a fresh in-memory one.
   *
   * Deliberately NOT shared across replicas: a shared breaker would let one
   * replica's bad luck stop every replica, and would need consensus about
   * who owns the half-open probe. Each replica discovering the vendor is
   * down independently costs a few extra requests and needs no coordination.
   */
  readonly breaker?: DestinationCircuitBreaker;
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
   * How long the per-`(project, environment)` list of active destination
   * instances is held before it is re-read from PostgreSQL. Defaults to
   * 10_000 ms.
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
  readonly rateLimiter: DestinationRateLimiterLike;
  readonly breaker: DestinationCircuitBreaker;
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
  const breaker = options.breaker ?? new DestinationCircuitBreaker();
  const dedupe = options.dedupe ?? new InMemoryDestinationDedupe();
  const metrics = options.metrics ?? new DestinationMetrics();
  const allowReplay = options.allowReplay ?? false;
  const activeInstanceTtlMs = options.activeInstanceTtlMs ?? DEFAULT_ACTIVE_INSTANCE_TTL_MS;

  /**
   * Per-`(project, environment)` cache of active destination ids for this
   * vendor.
   *
   * `findActiveByVendorAndProject` is a table scan on
   * `(vendor, environment, project_id, status)`; the fan-out consults it once
   * per message, so it is cached behind a short TTL. One consumer process
   * serves whatever projects and environments appear on the shared stream, and
   * each pair has its own destination rows.
   *
   * The key gained `project` with the fan-out filter. Keyed by environment
   * alone it was not merely coarse — it was the cache for a lookup that
   * ignored the project, so one project's target list was served to every
   * project on the stream.
   */
  const activeTargets = new Map<string, { ids: readonly string[]; expiresAt: number }>();

  async function resolveFanoutTargets(
    payload: TransportMessagePayload,
    envelope: NormalizableEnvelope,
  ): Promise<readonly string[]> {
    const pinned = readDestinationIdHeader(payload);
    if (pinned !== undefined) return [pinned];

    const environment = envelope.environment;
    const projectId = envelope.project_id;
    // NUL-joined; project ids and environments both forbid NUL, so no pair of
    // distinct scopes can collide on one key.
    const cacheKey = `${projectId}\0${environment}`;
    const nowMs = now().getTime();
    const cached = activeTargets.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > nowMs) return cached.ids;

    const rows = await options.instances.findActiveByVendorAndProject(
      options.descriptor.identity.vendor,
      environment,
      projectId,
    );
    const ids = rows.map((row) => row.destination_id);
    activeTargets.set(cacheKey, {
      ids,
      expiresAt: nowMs + activeInstanceTtlMs,
    });
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
      projectConfig: options.projectConfig,
      projectPolicies: options.projectPolicies,
      producer: options.producer,
      logger: options.logger,
      now,
      rateLimiter,
      breaker,
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
    // instance of this consumer's vendor belonging to the envelope's PROJECT
    // and environment.
    //
    // `project_id` is a routing key, and that took a correction. Fan-out
    // resolved on `(vendor, environment)` alone, so an event from project A
    // was delivered to project B's destination row of the same vendor:
    // `project_id` rode the envelope and was stamped onto metrics and
    // delivery records, but nothing routed on it. Resolving per-project
    // CONFIG while routing ignored the project would have been incoherent on
    // top of being a cross-project disclosure.
    //
    // A `polaris-destination-id` header overrides the fan-out and pins
    // the envelope to exactly one instance. That is the replay path:
    // `polaris replay` re-sends historical traffic to one named
    // destination, and must not splash it across every instance that
    // happens to be active now.
    const targets = await resolveFanoutTargets(payload, envelope);
    if (targets.length === 0) {
      // Not an error: a vendor with no destination rows for this
      // project and environment is the normal state of a consumer nobody has
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
          projectConfig: options.projectConfig,
          projectPolicies: options.projectPolicies,
          producer: options.producer,
          logger: options.logger,
          now,
          rateLimiter,
          breaker,
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
    // `resolved.events`, not the retired `analytics.events`. A destination
    // that names no input family gets the spine, which since 126EPNIQ is
    // the only source of customer events -- the old default would have had
    // it subscribe to a family nothing declares or produces.
    const configured = options.inputFamily ?? STREAM_FAMILY_RESOLVED_EVENTS;
    const families = (Array.isArray(configured) ? configured : [configured]).flatMap((family) => [
      // Shared plus each isolated project's dedicated stream. Per family:
      // a destination reading both `resolved.events` and `profile.events`
      // can have a project isolated on one and not the other.
      ...consumerFamiliesFor(family, options.isolation?.isolatedProjects(family) ?? []),
    ]);
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
    await options.consumer.subscribe({
      families: [...families],
      queues: [redeliver],
    });
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

  return { start, stop, handler, handleEvent, metrics, rateLimiter, breaker, dedupe };
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
  readonly projectConfig: ProjectConfigLookup | undefined;
  readonly projectPolicies: ReadonlyMap<string, ProjectPolicyOverride> | undefined;
  readonly producer: PolarisProducer;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly rateLimiter: DestinationRateLimiterLike;
  readonly breaker: DestinationCircuitBreaker;
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
    projectConfig,
    projectPolicies,
    producer,
    logger,
    now,
    rateLimiter,
    breaker,
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

  // Resolved once, here, and used by the gate, the deliverer and every
  // delivery row. Cache-only and synchronous, so resolving it before the
  // test-mode short circuit costs nothing and lets even that row name the
  // configuration that produced it.
  const resolvedConfig =
    projectConfig?.resolve(envelope.project_id, envelope.environment) ?? EMPTY_CONFIG;
  const projectConfigValues = resolvedConfig.values;

  if (instance.mode === "test") {
    // Test mode = no network delivery. The runtime still records a
    // delivery row so smoke tests / smoke harness can assert end-to-end
    // shape, but it short-circuits before mapping / delivering.
    return recordOutcome({
      ...outcomeBuildVersion,
      configVersion: resolvedConfig.version,
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

  const delivery_key = buildDeliveryKey({
    destination_id: instance.destination_id,
    event_id: envelope.event_id,
    identity,
  });

  // Resolved ONCE, here, and reused by the deliverer below. Two separate
  // `valuesFor` calls could straddle a config invalidation and hand the gate
  // and the deliverer different slices for the same event.

  // 3. Gate: is this event FOR this instance at all?
  //
  // Ahead of dedupe rather than after it, on cost: an instance subscribed to
  // one event type should not pay a dedupe round trip for the nineteen it
  // does not want. Nothing is lost by the ordering — the dedupe window is
  // only ever marked on an accepted delivery, so a gated event was never
  // going to consume it.
  const gateDecision = evaluateGate({
    envelope,
    config: resolveRoutingGateConfig({
      projectValues: projectConfigValues,
      instanceValues: instance.config,
    }),
    vendorConsent: descriptor.requiredConsent,
  });
  if (gateDecision.kind === "skip") {
    return recordOutcome({
      ...outcomeBuildVersion,
      configVersion: resolvedConfig.version,
      records,
      metrics,
      logger,
      identity,
      instance,
      envelope,
      attempt,
      startedAt,
      now,
      status: "skipped_filtered",
      // Null, and the whole point of the status. Nothing failed: the
      // instance is configured not to want this event.
      error_class: null,
      vendor_response_code: null,
      vendor_response_summary: gateDecision.detail,
      dedupe_key: null,
      delivery_key,
      skipReason: gateDecision.reason,
      logLine: `destination gate skip: ${gateDecision.reason}`,
      labels: instanceLabels,
    });
  }

  // 4. Destination-side dedupe.
  // A CLAIM, not a check. `seen()` then deliver was check-then-act: two
  // replicas both missed, both delivered, both marked. Only one caller is
  // told to proceed now, and the loser is the duplicate.
  const claim = await dedupe.claim(instance.destination_id, delivery_key, startedAt.getTime());
  if (claim.kind === "duplicate") {
    const dedupedAt = claim.deliveredAt;
    metrics.incrementDeduped(instanceLabels);
    logger.info(
      {
        component: "destination.runtime",
        ...instanceLabels,
        event_id: envelope.event_id,
        delivery_key,
        // Absent when the holder is a claim nobody has confirmed yet —
        // another replica is mid-delivery for this exact event right now.
        ...(dedupedAt !== undefined
          ? { previously_delivered_at: new Date(dedupedAt).toISOString() }
          : { concurrent_claim: true }),
      },
      "destination dedupe window already holds this event — skipping",
    );
    return null;
  }

  /**
   * Give the claim back on a path that never reached the vendor.
   *
   * Every exit between the claim and `invokeDeliverer` is one where nothing
   * was sent, so holding the key would only refuse a later replay of an
   * event this instance never delivered. Cheap to call and safe to repeat —
   * `release` ignores a claim that has already been confirmed.
   */
  const releaseClaim = (): Promise<void> => dedupe.release(instance.destination_id, delivery_key);

  // 5. Normalize.
  //
  // The project override is keyed off the ENVELOPE's project_id, not the
  // instance's: the policy belongs to the data, and a destination
  // instance can receive events from a project other than the one that
  // configured it.
  const projectPolicyOverride = projectPolicies?.get(envelope.project_id);
  const normalizeOutcome = normalizeForDestination(envelope, {
    destinationId: instance.destination_id,
    requiredConsent: descriptor.requiredConsent,
    ...(descriptor.identityHashing !== undefined
      ? { identityHashing: descriptor.identityHashing }
      : {}),
    ...(descriptor.identityFromProperties !== undefined
      ? { identityFromProperties: descriptor.identityFromProperties }
      : {}),
    ...(projectPolicyOverride !== undefined ? { projectPolicyOverride } : {}),
  });
  if (normalizeOutcome.kind === "drop") {
    await releaseClaim();
    return recordDrop({
      ...outcomeBuildVersion,
      configVersion: resolvedConfig.version,
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

  // 6. Map.
  const mapper: Mapper<Payload> | undefined = descriptor.mappers[normalized.event];
  if (mapper === undefined) {
    await releaseClaim();
    return recordOutcome({
      ...outcomeBuildVersion,
      configVersion: resolvedConfig.version,
      records,
      metrics,
      logger,
      identity,
      instance,
      envelope,
      attempt,
      startedAt,
      now,
      // NOT `mapped_failed`. A vendor registers mappers for the events it
      // has semantics for; every other event reaching a passing gate is
      // simply one this vendor does not model. Recording that as a mapping
      // FAILURE is the planned-skip-looks-like-failure defect: it put
      // routine operation into the error class, so a dashboard counting
      // `mapped_failed` counted a healthy consumer as broken, and a real
      // mapper fault had nowhere quiet to stand out from.
      status: "skipped_unmapped",
      error_class: null,
      vendor_response_code: null,
      vendor_response_summary: `no mapper for event '${normalized.event}'`,
      dedupe_key: null,
      delivery_key,
      skipReason: "unmapped",
      logLine: "no mapper registered for event — skipped_unmapped",
      labels: instanceLabels,
    });
  }

  let mapResult: MapperResult<Payload>;
  const mapperContext: MapperContext = { normalized, instance };
  try {
    mapResult = mapper(mapperContext);
  } catch (err) {
    await releaseClaim();
    return recordOutcome({
      ...outcomeBuildVersion,
      configVersion: resolvedConfig.version,
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
    await releaseClaim();
    return recordOutcome({
      ...outcomeBuildVersion,
      configVersion: resolvedConfig.version,
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

  // 7. Rate limit + deliver.
  //
  // No secret-resolution step precedes this any more. It used to sit here and
  // could fail on its own — a provider unreachable, a reference nobody
  // provisioned — which is why it carried a transient/permanent split, a
  // DLQ branch and an `error_class: 'auth'` outcome of its own. The credential
  // now arrives on the instance row, so the only way to reach the deliverer
  // without one is a destination row that does not exist, which step 1 already
  // handles. A credential that is present but wrong is the vendor's 401, and
  // that has always been the deliverer's to report.
  // The breaker sits after the gate and the claim but BEFORE the rate-limit
  // lease: a destination that is cut off should not spend a concurrency slot
  // or an RPS entry to find that out. The claim is released so the event can
  // be delivered by the retry that follows.
  const breakerScope = breakerKey(instance.destination_id, instance.environment);
  const breakerDecision = breaker.check(breakerScope);
  metrics.setBreakerState(instanceLabels, breakerDecision.state);
  if (!breakerDecision.allowed) {
    await releaseClaim();
    logger.warn(
      {
        component: "destination.runtime",
        ...instanceLabels,
        event_id: envelope.event_id,
        breaker_state: breakerDecision.state,
        retry_after_ms: breakerDecision.retryAfterMs,
      },
      "destination circuit breaker is open — not attempting delivery",
    );
    return recordOutcome({
      ...outcomeBuildVersion,
      configVersion: resolvedConfig.version,
      records,
      metrics,
      logger,
      identity,
      instance,
      envelope,
      attempt,
      startedAt,
      now,
      // Retryable, not a drop: the event is fine and the vendor is expected
      // back. It parks in a tier and returns after the cooldown.
      status: "failed_retryable",
      error_class: "transient",
      vendor_response_code: null,
      vendor_response_summary: `circuit breaker ${breakerDecision.state}`,
      dedupe_key: null,
      delivery_key,
      logLine: "destination circuit breaker open",
      labels: instanceLabels,
      ...(payload !== undefined
        ? {
            retryPark: {
              payload,
              component: identity.component,
              delayMs: retryDelayMsFor(instance.retry_policy, attempt),
            },
          }
        : { rethrow: new Error(`circuit breaker ${breakerDecision.state}`) }),
      producer,
      ...(dlqRecords !== undefined ? { dlqRecords } : {}),
    });
  }

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
        secret: instance.secret_value,
        ...(vendor_dedupe_key !== null ? { dedupe_key: vendor_dedupe_key } : {}),
        attempt,
        delivery_key,
        // Empty when no store is wired or the scope is cold. Deliverers fall
        // back to their constructed defaults, which is what the migrated
        // environment variable meant.
        projectConfig: projectConfigValues,
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
      configVersion: resolvedConfig.version,
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
  // No secret to release here. Dropping the local alias meant something while
  // the plaintext was resolved per attempt and this function held the only
  // reference; the credential now lives on the cached destination instance for
  // the cache's TTL either way, so clearing an alias would be theatre.

  if (deliveryResult.kind === "accepted") {
    // The vendor answered. A successful half-open probe closes the breaker
    // outright rather than counting down toward closed.
    breaker.onSuccess(breakerScope);
    metrics.observeFreshnessMs(
      instanceLabels,
      deliveryFinishedAt.getTime() - Date.parse(envelope.occurred_at),
    );
    metrics.setBreakerState(instanceLabels, breaker.stateOf(breakerScope));
    // Extends this caller's claim to the full window. Until now the claim
    // was short-lived on purpose; the vendor has accepted, so the key is
    // genuinely spent.
    await dedupe.mark(instance.destination_id, delivery_key, deliveryFinishedAt.getTime());
    return recordOutcome({
      ...outcomeBuildVersion,
      configVersion: resolvedConfig.version,
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
    // Only TRANSIENT failures feed the breaker. A permanent failure means
    // this event was wrong, not that the vendor is — counting those would
    // let a burst of malformed events stop delivery of everything else.
    metrics.setBreakerState(instanceLabels, breaker.onFailure(breakerScope));
    // The claim goes back before the record is written. This event comes
    // round again when its retry tier expires, and it must not find its own
    // claim in the way.
    await dedupe.release(instance.destination_id, delivery_key);
    return recordOutcome({
      ...outcomeBuildVersion,
      configVersion: resolvedConfig.version,
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
      // Two paths, and which one applies is decided by whether we hold the
      // original transport message.
      //
      // With a payload, the failure is PARKED: republished to the retry tier
      // this instance's `retry_policy` selects, with the attempt counter
      // bumped, and the broker holds it for the tier's TTL before releasing
      // it to `<component>.redeliver`. No rethrow — rethrowing as well would
      // make the broker requeue the same message we just parked, delivering
      // it twice.
      //
      // Without one (`handleEvent`, driven directly by tests and by replay
      // tooling) there is nothing to republish, so the previous behaviour
      // stands: rethrow and let the caller decide.
      //
      // This is what makes `dead_letter_threshold` reachable at all. Nothing
      // republished to a retry tier before this, so `polaris-retry-attempts`
      // never incremented, `attempt` was always 1, and a threshold of 5 could
      // not be crossed by any sequence of failures.
      ...(payload !== undefined
        ? {
            retryPark: {
              payload,
              component: identity.component,
              delayMs: retryDelayMsFor(instance.retry_policy, attempt),
            },
          }
        : { rethrow: buildRetryableError(deliveryResult) }),
      // At-or-above the threshold the message goes to the DLQ instead of
      // another tier — `recordOutcome` prefers `payloadForDlq` over
      // `retryPark` when both are set.
      ...(attempt >= instance.dead_letter_threshold && payload !== undefined
        ? { payloadForDlq: payload }
        : {}),
      producer,
      ...(dlqRecords !== undefined ? { dlqRecords } : {}),
    });
  }

  // Neither accepted nor retryable: the claim must go back, or the key stays
  // blocked for its TTL and a replay of this event would be refused by a
  // delivery that never happened.
  await dedupe.release(instance.destination_id, delivery_key);

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
  /**
   * `reason` label for a `skipped_*` status.
   *
   * Every other outcome takes its metric reason from `error_class`, but a
   * planned skip has none by design — nothing failed. Without this the skip
   * counter would carry no reason at all and "why did this instance go
   * quiet?" would be unanswerable from metrics alone.
   */
  readonly skipReason?: string;
  /** Operational build version (M0DROHV3) stamped on the row. Forwarded by the runtime from `DestinationConsumerOptions.consumerBuildVersion`. */
  readonly consumerBuildVersion?: string;
  /**
   * Project-config version in force for this delivery. Comes from the same
   * single `resolve` the routing gate read, so the row and the decision it
   * describes can never name different versions.
   */
  readonly configVersion?: string | null;
  /** When set, the runtime publishes the original payload to the DLQ. */
  readonly payloadForDlq?: TransportMessagePayload;
  /**
   * When set, the runtime parks the original message in a retry tier instead
   * of rethrowing. `payloadForDlq` wins when both are present: at the
   * dead-letter threshold the message stops going round.
   */
  readonly retryPark?: {
    readonly payload: TransportMessagePayload;
    readonly component: string;
    readonly delayMs: number;
  };
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
    // Always written, including as null: the column's job is to answer
    // "which configuration produced this?", and a null answers it — no
    // store was consulted — where an absent key answers nothing.
    config_version: input.configVersion ?? null,
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
    } else if (input.status.startsWith("skipped_")) {
      // Ahead of the `dropped_` branch and, more importantly, ahead of the
      // `else`. Routing here is by status PREFIX, so a status that matched
      // neither would be counted as a failure — which is precisely the
      // defect these statuses exist to close, reproduced one layer down in
      // the metrics. A planned skip is not an error anywhere.
      input.metrics.incrementSkipped({
        ...input.labels,
        ...(input.skipReason !== undefined ? { reason: input.skipReason } : {}),
      });
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
    // `secret_ref` used to be logged here on EVERY delivery, and was safe
    // while it named a pointer rather than holding a credential. The column
    // holds the credential now, so this line became the single highest-volume
    // disclosure in the platform — one log entry per delivered event, in
    // whatever aggregator the fleet ships to. `destination_id` and
    // `instance_label` already identify the row for triage.
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

  if (
    input.retryPark !== undefined &&
    input.producer !== undefined &&
    input.payloadForDlq === undefined
  ) {
    const { payload, component, delayMs } = input.retryPark;
    await republishToRetry(input.producer, {
      component,
      value: payload.message.value,
      key: payload.message.key ?? null,
      headers: payload.message.headers,
      sourceTopic: payload.stream,
      sourcePartition: payload.partition,
      reason: input.error_class ?? "transient",
      ...(input.vendor_response_summary !== null
        ? { errorMessage: input.vendor_response_summary }
        : {}),
      failedAt: input.now().toISOString(),
      // The attempt this delivery WAS, so the helper's own increment lands
      // on the next one. Passing it explicitly rather than letting the
      // helper read the header keeps one source of truth for the count —
      // the runtime already parsed it, and a second parse could disagree.
      attempts: input.attempt + 1,
    });
    input.logger.info(
      {
        component: "destination.runtime",
        ...input.labels,
        event_id: input.envelope.event_id,
        delivery_key: input.delivery_key,
        attempt: input.attempt,
        retry_policy: input.instance.retry_policy,
        delay_ms: delayMs,
      },
      "destination delivery parked in a retry tier",
    );
    input.metrics.incrementRetry({ ...input.labels, reason: input.error_class ?? "transient" });
    return record;
  }

  if (input.rethrow !== undefined) {
    if (input.rethrow instanceof Error) throw input.rethrow;
    throw new Error(String(input.rethrow));
  }

  return record;
}

interface RecordDropInput {
  /** Operational build version, same as every other outcome carries. */
  readonly consumerBuildVersion?: string;
  /** Project-config version, same as every other outcome carries. */
  readonly configVersion?: string | null;
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
  // `consumerBuildVersion` is forwarded like every other outcome. It was
  // absent from `RecordDropInput` entirely, so every drop row wrote NULL
  // while every accepted, failed and skipped row carried the build — which
  // made "which build dropped these?" the one question the column could not
  // answer, on exactly the rows an operator asks it about.
  const status: DeliveryRecordStatus = mapDropReasonToStatus(input.reason);
  const error_class: DeliveryRecordErrorClass = mapDropReasonToErrorClass(input.reason);
  return recordOutcome({
    ...(input.consumerBuildVersion !== undefined
      ? { consumerBuildVersion: input.consumerBuildVersion }
      : {}),
    configVersion: input.configVersion ?? null,
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
  // Empty, not a plausible-looking value. This object exists only to stamp DLQ
  // headers for failures that happen before a real instance is resolved, so
  // there is no credential to carry — and an empty one cannot be mistaken for
  // a real credential if this object ever reaches somewhere it should not.
  secret_value: "",
  status: "active",
  mode: "live",
  max_concurrency: 1,
  max_rps: 1,
  retry_policy: "standard",
  dead_letter_threshold: 1,
  // Placeholder is opt-out: this row only stamps DLQ headers on
  // pre-resolve failures; it never goes through the replay gate.
  replay_opt_in: false,
  // No instance was resolved, so there is no instance configuration. Empty
  // is also the safe value for the gate: it overrides nothing.
  config: {},
};
