/**
 * Streaming runtime: wires KafkaJS consumer → pure transform → KafkaJS
 * producer, with the session store layered between.
 *
 * Shape mirrors `processors/identity-resolver/v1/src/runtime.ts` so every
 * Polaris processor uses the same per-message contract:
 *
 *   1. Subscribe a `PolarisConsumer` to the `raw.events` topic family
 *      (plus any isolated per-project topics).
 *
 *   2. For each message:
 *        - decode the canonical envelope,
 *        - validate the minimum envelope fields the sessionizer needs,
 *        - run the pure `decideSession` transform against the prior
 *          store record,
 *        - branch on the decision kind:
 *            * `drop`             — no usable identifier; metric only.
 *            * `start`            — emit `session.started`, write the
 *                                   opened record back.
 *            * `continue`         — update last_seen_at / event_count
 *                                   in the store; no emission.
 *            * `expire_and_start` — emit `session.ended` for the prior
 *                                   session AND `session.started` for
 *                                   the new one, in that order. Replace
 *                                   the store record.
 *        - record consume / emit / failure counters on
 *          `@polaris/shared-processor`'s `ProcessorMetrics`,
 *        - on error: classify via the shared `classifyError`, increment
 *          the failed counter, and re-throw so KafkaJS surfaces the
 *          failure through its own retry path.
 *
 * The runtime accepts the store as a dependency so tests inject the
 * in-memory adapter and production wires the Redis-backed one (ADR 0005).
 * Every write passes the inactivity window as a TTL, so the store forgets
 * a session at the moment the domain says it is over.
 *
 * Topic strategy: the manifest declares the output family as
 * `session.events`, but `session.events` is NOT in the canonical topic
 * family list yet (only `raw.events`, `identity.events`,
 * `enriched.events`, `attribution.events`, `analytics.events` per
 * `docs/architecture/03-rabbitmq-streams.md`). To stay inside the task's
 * declared write scope, the runtime publishes via the producer's
 * lower-level `send` method with an explicit topic name and manually-
 * built headers and partition key. Adding `STREAM_FAMILY_SESSION_EVENTS`
 * to `@polaris/shared-transport` is a follow-up cross-cut.
 *
 * Caller-owned DLQ orchestration: the runtime does not auto-route to
 * DLQ. Hosts that want DLQ routing wrap the handler with `publishToDlq`
 * from `@polaris/shared-processor`.
 */

import type { Logger } from "@polaris/shared-logger";
import {
  ALWAYS_ENABLED_GATE,
  classifyError,
  deriveEventId,
  type ProcessorActivationGate,
  type ProcessorMetricLabels,
  ProcessorMetrics,
  type ProcessorRetryClassification,
} from "@polaris/shared-processor";
import {
  buildRawEventsPartitionKey,
  consumerFamiliesFor,
  decodeEvent,
  type PolarisConsumer,
  type PolarisProducer,
  type PublishableEvent,
  type PublishResult,
  STREAM_FAMILY_RAW_EVENTS,
  STREAM_FAMILY_SESSION_EVENTS,
  type SyncIsolationLookup,
  sharedOnlyIsolationLookup,
  type TransportMessageContext,
  type TransportMessageHandler,
} from "@polaris/shared-transport";

import {
  buildSessionEndedEnvelope,
  buildSessionStartedEnvelope,
  type SessionEndedProperties,
  type SessionEventEnvelope,
  type SessionEventName,
  type SessionStartedProperties,
} from "./emit.js";
import { buildContinuedRecord, buildOpenedRecord, type SessionStore } from "./store.js";
import {
  buildSessionStoreKey,
  DEFAULT_INACTIVITY_SECONDS,
  decideSession,
  PROCESSOR_NAME,
  PROCESSOR_VERSION,
  resolvePrimaryIdentifier,
} from "./transform.js";
import type { RawEventEnvelope } from "./types.js";

/**
 * Output topic name. Per the manifest, the sessionizer publishes on
 * `session.events`. The constant lives in the runtime (rather than in
 * `@polaris/shared-transport`) so v1 stays inside the task's write scope —
 * see the file header comment.
 */
export const OUTPUT_STREAM_FAMILY = STREAM_FAMILY_SESSION_EVENTS;

/**
 * Dependencies for the runtime. The factory accepts already-built
 * consumer/producer so the binary entry point owns lifecycle wiring,
 * tests can inject in-memory fakes, and the runtime stays a pure
 * function of its inputs.
 */
export interface SessionizerRuntimeDeps {
  readonly consumer: PolarisConsumer;
  readonly producer: PolarisProducer;
  readonly store: SessionStore;
  readonly logger: Logger;
  /**
   * Sync isolation lookup. Defaults to `sharedOnlyIsolationLookup`. Every
   * project flows through the shared topics until the isolation control
   * plane wires the PostgreSQL adapter.
   */
  readonly isolation?: SyncIsolationLookup;
  /**
   * Projects currently isolated for `raw.events`. The consumer subscribes
   * to their dedicated topics in addition to the shared one.
   */
  readonly isolatedProjects?: ReadonlyArray<string>;
  /** Override for `() => new Date()` so tests can pin emission timestamps. */
  readonly now?: () => Date;
  /**
   * `ProcessorMetrics` registry. The runtime increments consume / emit /
   * failure counters here. Defaults to a fresh registry so tests still
   * observe their own metrics.
   */
  readonly metrics?: ProcessorMetrics;
  /**
   * Activation gate consulted per message. Defaults to
   * {@link ALWAYS_ENABLED_GATE} so a runtime built outside `app.ts` (unit
   * tests, golden fixtures) needs no database. Production passes the
   * PostgreSQL-backed gate, which is what makes `polaris processors disable`
   * actually stop this processor for the scopes it names.
   */
  readonly gate?: ProcessorActivationGate;
  /**
   * Per-run identifier (UUIDv7) from `openProcessorRun`. Stamped onto every
   * emitted event in both the nested `processor.run_id` slot and the property
   * `run_id` field. Required: it identifies the `processor_runs` row this
   * output belongs to, and a fabricated stand-in would look joinable without
   * being so. `app.ts` always supplies it.
   */
  readonly run_id: string;
  /**
   * UUIDv7 allocator. Tests inject a deterministic counter; production
   * uses the real `uuidv7()`.
   */
  readonly newEventId?: () => string;
  /**
   * Inactivity window in seconds. Defaults to
   * `DEFAULT_INACTIVITY_SECONDS` (1800). Operators may wire this from
   * the manifest's `defaults.session_inactivity_seconds` at boot. Per
   * the manifest comments, this value is SEMANTIC — changing it
   * requires a new processor version.
   */
  readonly inactivity_seconds?: number;
  /**
   * Producer identity stamped into Kafka headers. Defaults to
   * `${PROCESSOR_NAME}-${PROCESSOR_VERSION}`.
   */
  readonly producer_name?: string;
  /** Producer version stamped into Kafka headers. Defaults to undefined. */
  readonly producer_version?: string;
}

/** Runtime handle returned by `createRuntime`. */
export interface SessionizerRuntime {
  /** Subscribe and start consuming. Idempotent. */
  start(): Promise<void>;
  /** Stop the underlying consumer. Idempotent. */
  stop(): Promise<void>;
  /**
   * Expose the message handler for direct testing without a running
   * KafkaJS cluster.
   */
  readonly handler: TransportMessageHandler;
  /** Metrics registry the runtime is wired to. */
  readonly metrics: ProcessorMetrics;
  /** In-memory store the runtime is wired to. Mostly for tests. */
  readonly store: SessionStore;
  /**
   * The inactivity window this runtime is actually using. Exposed so a
   * test can assert it equals the manifest constant regardless of what
   * env asked for — the window is semantic, and "the code ignores the
   * env var" is a claim worth pinning rather than commenting.
   */
  readonly inactivitySeconds: number;
}

/**
 * Build the streaming runtime. The factory does not connect the consumer
 * or producer — the binary entry point owns connection lifecycle.
 */
export function createRuntime(deps: SessionizerRuntimeDeps): SessionizerRuntime {
  const isolation = deps.isolation ?? sharedOnlyIsolationLookup;
  const isolatedProjects = deps.isolatedProjects ?? [];
  const metrics = deps.metrics ?? new ProcessorMetrics();
  const gate = deps.gate ?? ALWAYS_ENABLED_GATE;
  // No uuidv7 fallback: absence means "derive the id from the cause",
  // which is the production path. Tests inject a counter.
  const newEventId = deps.newEventId;
  const inactivitySeconds = deps.inactivity_seconds ?? DEFAULT_INACTIVITY_SECONDS;
  const producerName = deps.producer_name ?? `${PROCESSOR_NAME}-${PROCESSOR_VERSION}`;

  const handler: TransportMessageHandler = async (payload, context) => {
    await handleMessage({
      payload,
      context,
      producer: deps.producer,
      store: deps.store,
      logger: deps.logger,
      metrics,
      gate,
      ...(newEventId !== undefined ? { newEventId } : {}),
      inactivitySeconds,
      producerName,
      isolation,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      run_id: deps.run_id,
      ...(deps.producer_version !== undefined ? { producerVersion: deps.producer_version } : {}),
    });
  };

  let started = false;
  async function start(): Promise<void> {
    if (started) return;
    started = true;
    const families = consumerFamiliesFor(STREAM_FAMILY_RAW_EVENTS, isolatedProjects);
    await deps.consumer.subscribe({ families: [...families] });
    deps.logger.info(
      {
        component: "sessionizer.runtime",
        families,
        isolated_projects: isolatedProjects,
        inactivity_seconds: inactivitySeconds,
      },
      "sessionizer subscribed to raw.events",
    );
    await deps.consumer.runEach(handler);
  }

  async function stop(): Promise<void> {
    if (!started) return;
    started = false;
    await deps.consumer.disconnect();
  }

  return { start, stop, handler, metrics, store: deps.store, inactivitySeconds };
}

// ---------------------------------------------------------------------------
// Per-message pipeline
// ---------------------------------------------------------------------------

interface HandleMessageInput {
  readonly payload: Parameters<TransportMessageHandler>[0];
  readonly context: TransportMessageContext;
  readonly producer: PolarisProducer;
  readonly store: SessionStore;
  readonly logger: Logger;
  readonly metrics: ProcessorMetrics;
  /** Activation gate, consulted once the envelope's scope is known. */
  readonly gate: ProcessorActivationGate;
  readonly newEventId?: (() => string) | undefined;
  readonly inactivitySeconds: number;
  readonly producerName: string;
  readonly producerVersion?: string;
  readonly isolation: SyncIsolationLookup;
  readonly now?: () => Date;
  /** Run emitting these events. Threaded down from `createRuntime`'s deps. */
  readonly run_id: string;
}

async function handleMessage(input: HandleMessageInput): Promise<void> {
  const { payload, context, store, logger, metrics, gate, newEventId, inactivitySeconds } = input;
  const value = payload.message.value;
  if (value === null || value.length === 0) {
    // Tombstone-style empty payload. Drop with a warn.
    logger.warn(
      {
        component: "sessionizer.handler",
        topic: payload.stream,
        partition: payload.partition,
        offset: payload.message.offset,
        ...(context.event_id !== undefined ? { event_id: context.event_id } : {}),
      },
      "skipping empty/tombstone message",
    );
    return;
  }

  let decoded: unknown;
  try {
    decoded = decodeEvent(value);
  } catch (err) {
    handleClassifiedError(err, {
      payload,
      context,
      metrics,
      logger,
      message: "failed to decode raw.events payload",
    });
    throw err;
  }

  const raw = assertEnvelope(decoded);
  if (raw === undefined) {
    const fail = new Error("sessionizer: raw.events payload missing required envelope fields");
    handleClassifiedError(fail, {
      payload,
      context,
      metrics,
      logger,
      message: "raw.events payload missing required envelope fields",
    });
    throw fail;
  }

  const labels: ProcessorMetricLabels = {
    processor_name: PROCESSOR_NAME,
    processor_version: PROCESSOR_VERSION,
    project_id: raw.project_id,
    environment: raw.environment,
  };
  // Activation gate. Consulted here rather than at startup because the scope
  // only exists once the envelope is decoded — processors read every
  // project's events off one shared stream. A disabled scope is acknowledged
  // and counted, never retried or dead-lettered: an operator switching a
  // processor off is a decision, not a failure. Counted BEFORE
  // `incrementConsumed` so "consumed" keeps meaning "acted on".
  if (!(await gate.isEnabled({ project_id: raw.project_id, environment: raw.environment }))) {
    metrics.incrementSkipped({ ...labels, reason: "processor_disabled" });
    logger.debug(
      {
        component: "sessionizer.handler",
        project_id: raw.project_id,
        environment: raw.environment,
        topic: payload.stream,
        partition: payload.partition,
        offset: payload.message.offset,
        reason: "processor_disabled",
      },
      "processor disabled for this scope; skipping event",
    );
    return;
  }

  metrics.incrementConsumed(labels);

  /**
   * Identity of each derived event, as a pure function of its cause.
   *
   * Keyed on the SOURCE event id and an emission slot, never on the attempt:
   * a redelivery or a replay of the same input reproduces the same id, so
   * `analytics_processed`'s ReplacingMergeTree collapses the duplicate instead
   * of accumulating it as a second fact. `newEventId` remains injectable for
   * tests that need a counter, and overrides this when supplied.
   */
  const derivedEventId = (slot: string): string =>
    newEventId !== undefined
      ? newEventId()
      : deriveEventId({ processor: PROCESSOR_NAME, sourceEventId: raw.event_id, slot });

  // Resolve the primary identifier first so the runtime can look up the
  // store record before running the pure transform. The transform takes
  // (raw, prior, inactivity_seconds) and is the single source of truth
  // for the decision branch.
  const primary = resolvePrimaryIdentifier(raw.identity);
  if (primary === undefined) {
    logger.debug(
      {
        component: "sessionizer.handler",
        project_id: raw.project_id,
        environment: raw.environment,
        event_id: raw.event_id,
        source_topic: payload.stream,
      },
      "dropping event: no usable primary identifier",
    );
    return;
  }
  const storeKey = buildSessionStoreKey({
    project_id: raw.project_id,
    environment: raw.environment,
    primary,
  });
  const prior = await store.get(storeKey);

  let actualDecision: ReturnType<typeof decideSession>;
  try {
    actualDecision = decideSession({
      raw,
      prior,
      inactivity_seconds: inactivitySeconds,
    });
  } catch (err) {
    handleClassifiedError(err, {
      payload,
      context: { ...context, project_id: raw.project_id, environment: raw.environment },
      metrics,
      logger,
      message: "decideSession failed",
    });
    throw err;
  }
  if (actualDecision.kind === "drop") {
    // resolvePrimaryIdentifier returned a non-empty primary above, so
    // this branch cannot fire. Keep it for exhaustive type narrowing.
    return;
  }

  const startedAt = Date.now();
  const nowFn = input.now ?? ((): Date => new Date());
  const runId = input.run_id;

  try {
    if (actualDecision.kind === "continue") {
      // No emission. Just bump the record.
      const next = buildContinuedRecord({
        prior: prior as NonNullable<typeof prior>,
        raw_event_id: raw.event_id,
        raw_occurred_at: raw.occurred_at,
      });
      await store.set(storeKey, next, inactivitySeconds);
      // Metric: count the consumed-but-unemitted observation through the
      // emit ledger by NOT incrementing `incrementEmitted`. The
      // `incrementConsumed` above already counted the input.
      metrics.observeHandlerDurationMs(labels, Date.now() - startedAt);
      logger.debug(
        {
          component: "sessionizer.handler",
          project_id: raw.project_id,
          environment: raw.environment,
          event_id: raw.event_id,
          session_id: next.session_id,
          event_count: next.event_count,
          source_topic: payload.stream,
        },
        "session continued (no emission)",
      );
      return;
    }

    if (actualDecision.kind === "start") {
      const properties: SessionStartedProperties = {
        session_id: actualDecision.session_id,
        primary_identifier_kind: actualDecision.primary.kind,
        primary_identifier_value: actualDecision.primary.value,
        started_at: actualDecision.started_at,
        source_event_id: raw.event_id,
        run_id: runId,
      };
      const envelope = buildSessionStartedEnvelope({
        raw,
        eventId: derivedEventId("started"),
        now: nowFn,
        run_id: runId,
        properties,
      });
      await publishSessionEnvelope({
        producer: input.producer,
        envelope,
        isolation: input.isolation,
        producerName: input.producerName,
        ...(input.producerVersion !== undefined ? { producerVersion: input.producerVersion } : {}),
      });
      metrics.incrementEmitted(labels);

      const opened = buildOpenedRecord({
        session_id: actualDecision.session_id,
        project_id: raw.project_id,
        environment: raw.environment,
        primary_identifier_kind: actualDecision.primary.kind,
        primary_identifier_value: actualDecision.primary.value,
        started_at: actualDecision.started_at,
        source_event_id: raw.event_id,
      });
      await store.set(storeKey, opened, inactivitySeconds);
      metrics.observeHandlerDurationMs(labels, Date.now() - startedAt);
      logger.debug(
        {
          component: "sessionizer.handler",
          project_id: envelope.project_id,
          environment: envelope.environment,
          event: envelope.event,
          event_id: envelope.event_id,
          session_id: actualDecision.session_id,
          source_event_id: raw.event_id,
          source_topic: payload.stream,
        },
        "session started",
      );
      return;
    }

    // expire_and_start: emit ended first, then started. The store is
    // updated after both publishes succeed.
    const endedProperties: SessionEndedProperties = {
      session_id: actualDecision.ended.session_id,
      primary_identifier_kind: actualDecision.primary.kind,
      primary_identifier_value: actualDecision.primary.value,
      started_at: actualDecision.ended.started_at,
      ended_at: actualDecision.ended.ended_at,
      last_seen_at: actualDecision.ended.last_seen_at,
      inactivity_seconds: inactivitySeconds,
      event_count: actualDecision.ended.event_count,
      run_id: runId,
    };
    const endedEnvelope = buildSessionEndedEnvelope({
      raw,
      eventId: derivedEventId("ended"),
      now: nowFn,
      run_id: runId,
      properties: endedProperties,
    });
    await publishSessionEnvelope({
      producer: input.producer,
      envelope: endedEnvelope,
      isolation: input.isolation,
      producerName: input.producerName,
      ...(input.producerVersion !== undefined ? { producerVersion: input.producerVersion } : {}),
    });
    metrics.incrementEmitted(labels);

    const startedProperties: SessionStartedProperties = {
      session_id: actualDecision.started.session_id,
      primary_identifier_kind: actualDecision.primary.kind,
      primary_identifier_value: actualDecision.primary.value,
      started_at: actualDecision.started.started_at,
      source_event_id: raw.event_id,
      run_id: runId,
    };
    const startedEnvelope = buildSessionStartedEnvelope({
      raw,
      eventId: derivedEventId("started"),
      now: nowFn,
      run_id: runId,
      properties: startedProperties,
    });
    await publishSessionEnvelope({
      producer: input.producer,
      envelope: startedEnvelope,
      isolation: input.isolation,
      producerName: input.producerName,
      ...(input.producerVersion !== undefined ? { producerVersion: input.producerVersion } : {}),
    });
    metrics.incrementEmitted(labels);

    const opened = buildOpenedRecord({
      session_id: actualDecision.started.session_id,
      project_id: raw.project_id,
      environment: raw.environment,
      primary_identifier_kind: actualDecision.primary.kind,
      primary_identifier_value: actualDecision.primary.value,
      started_at: actualDecision.started.started_at,
      source_event_id: raw.event_id,
    });
    await store.set(storeKey, opened, inactivitySeconds);
    metrics.observeHandlerDurationMs(labels, Date.now() - startedAt);
    logger.debug(
      {
        component: "sessionizer.handler",
        project_id: raw.project_id,
        environment: raw.environment,
        event_id: raw.event_id,
        ended_session_id: actualDecision.ended.session_id,
        started_session_id: actualDecision.started.session_id,
        source_topic: payload.stream,
      },
      "session expired and restarted",
    );
  } catch (err) {
    const classification: ProcessorRetryClassification = classifyError(err);
    metrics.incrementFailed({ ...labels, reason: classification.reason });
    logger.error(
      {
        component: "sessionizer.handler",
        project_id: raw.project_id,
        environment: raw.environment,
        event_id: raw.event_id,
        source_topic: payload.stream,
        source_partition: payload.partition,
        source_offset: payload.message.offset,
        retry_reason: classification.reason,
        retryable: classification.retryable,
        err: errSummary(err),
      },
      "failed to emit session event",
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Publish helper
// ---------------------------------------------------------------------------

/**
 * Publish a session envelope to the `session.events` super stream.
 *
 * This used to reach for the producer's low-level `send` with a
 * hand-built header bag, because `session.events` was not a canonical
 * family — it only existed because Redpanda auto-created topics on first
 * publish. RabbitMQ creates nothing, so the family is now declared like
 * every other one and this goes through `publishEvent`, which owns the
 * headers, the isolation lookup, and the partition routing.
 *
 * The partition key keeps the canonical `buildRawEventsPartitionKey`
 * shape so per-identity ordering is preserved across the raw → session
 * topology.
 */
async function publishSessionEnvelope(input: {
  readonly producer: PolarisProducer;
  readonly envelope: SessionEventEnvelope;
  readonly producerName: string;
  readonly producerVersion?: string;
  readonly isolation: SyncIsolationLookup;
}): Promise<PublishResult> {
  const { producer, envelope } = input;
  const partitionKey = buildRawEventsPartitionKey({
    project_id: envelope.project_id,
    environment: envelope.environment,
    event_id: envelope.event_id,
    identity: envelope.identity,
  });
  return producer.publishEvent({
    family: STREAM_FAMILY_SESSION_EVENTS,
    event: envelope as unknown as PublishableEvent,
    isolation: input.isolation,
    partitionKey,
  });
}

// ---------------------------------------------------------------------------
// Exports for tests / replay
// ---------------------------------------------------------------------------

export type { SessionEventEnvelope, SessionEventName };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ClassifiedErrorContext {
  readonly payload: Parameters<TransportMessageHandler>[0];
  readonly context: TransportMessageContext;
  readonly metrics: ProcessorMetrics;
  readonly logger: Logger;
  readonly message: string;
}

function handleClassifiedError(err: unknown, context: ClassifiedErrorContext): void {
  const classification = classifyError(err);
  context.metrics.incrementFailed({
    processor_name: PROCESSOR_NAME,
    processor_version: PROCESSOR_VERSION,
    ...(context.context.project_id !== undefined ? { project_id: context.context.project_id } : {}),
    ...(context.context.environment !== undefined
      ? { environment: context.context.environment }
      : {}),
    reason: classification.reason,
  });
  context.logger.error(
    {
      component: "sessionizer.handler",
      topic: context.payload.stream,
      partition: context.payload.partition,
      offset: context.payload.message.offset,
      retry_reason: classification.reason,
      retryable: classification.retryable,
      ...(context.context.event_id !== undefined ? { event_id: context.context.event_id } : {}),
      err: errSummary(err),
    },
    context.message,
  );
}

function assertEnvelope(decoded: unknown): RawEventEnvelope | undefined {
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    return undefined;
  }
  const obj = decoded as Record<string, unknown>;
  if (typeof obj["event_id"] !== "string") return undefined;
  if (typeof obj["event"] !== "string") return undefined;
  if (typeof obj["schema_version"] !== "number") return undefined;
  if (typeof obj["project_id"] !== "string") return undefined;
  if (typeof obj["environment"] !== "string") return undefined;
  if (typeof obj["occurred_at"] !== "string") return undefined;
  if (typeof obj["ingested_at"] !== "string") return undefined;
  if (obj["source"] === null || typeof obj["source"] !== "object") return undefined;
  if (obj["identity"] === null || typeof obj["identity"] !== "object") return undefined;
  if (obj["context"] === null || typeof obj["context"] !== "object") return undefined;
  if (obj["properties"] === null || typeof obj["properties"] !== "object") return undefined;
  return obj as unknown as RawEventEnvelope;
}

function errSummary(err: unknown): { name?: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (typeof err === "string") return { message: err };
  return {};
}
