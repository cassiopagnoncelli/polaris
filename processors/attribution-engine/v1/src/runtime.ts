/**
 * Streaming runtime: wires KafkaJS consumer → pure transform → KafkaJS
 * producer, with an in-memory touchpoint store layered between.
 *
 * Shape mirrors `processors/sessionizer/v1/src/runtime.ts` and
 * `processors/identity-resolver/v1/src/runtime.ts` so every Polaris
 * processor uses the same per-message contract:
 *
 *   1. Subscribe a `PolarisConsumer` to the `analytics.events` topic
 *      family (plus any isolated per-project topics).
 *
 *   2. For each message:
 *        - decode the canonical envelope,
 *        - validate the minimum envelope fields the engine needs,
 *        - run the pure `decideAttribution` transform against the prior
 *          store record,
 *        - branch on the decision kind:
 *            * `drop` — no usable identifier OR empty campaign;
 *                       metric only.
 *            * `touchpoint_only` — emit `attribution.touchpoint_captured`
 *              only. Store keeps the same last-touch slot but increments
 *              the count.
 *            * `touchpoint_and_last` — emit `touchpoint_captured` then
 *              `last_touch_assigned`. Store advances the last-touch
 *              slot to the new touchpoint.
 *            * `first_observation` — emit `touchpoint_captured`, then
 *              `first_touch_assigned`, then `last_touch_assigned` in
 *              that order. Store opens a fresh chain record.
 *        - record consume / emit / failure counters on
 *          `@polaris/shared-processor`'s `ProcessorMetrics`,
 *        - on error: classify via the shared `classifyError`, increment
 *          the failed counter, and re-throw so KafkaJS surfaces the
 *          failure through its own retry path.
 *
 * The runtime accepts the store as a dependency so tests inject the
 * in-memory adapter and production wires the same adapter. v1 has no
 * Redis variant; a future v2 will swap implementations.
 *
 * Topic strategy: `attribution.events` is already a canonical topic
 * family in `@polaris/shared-kafka`, so the runtime publishes via the
 * producer's `publishEvent` helper (mirrors the identity-resolver
 * pattern).
 *
 * Caller-owned DLQ orchestration: the runtime does not auto-route to
 * DLQ. Hosts that want DLQ routing wrap the handler with `publishToDlq`
 * from `@polaris/shared-processor`.
 */

import { v7 as uuidv7 } from "uuid";

import type { Logger } from "@polaris/shared-logger";
import {
  type PolarisConsumer,
  type PolarisEachMessageHandler,
  type PolarisMessageContext,
  type PolarisProducer,
  type SyncIsolationLookup,
  buildRawEventsPartitionKey,
  consumerTopicsForFamily,
  decodeEvent,
  sharedOnlyIsolationLookup,
  TOPIC_FAMILY_ANALYTICS_EVENTS,
  TOPIC_FAMILY_ATTRIBUTION_EVENTS,
} from "@polaris/shared-kafka";
import {
  type ProcessorMetricLabels,
  type ProcessorRetryClassification,
  ProcessorMetrics,
  classifyError,
} from "@polaris/shared-processor";

import {
  type AttributionEventEnvelope,
  type AttributionEventName,
  type FirstTouchAssignedProperties,
  type LastTouchAssignedProperties,
  type TouchpointCapturedProperties,
  buildFirstTouchAssignedEnvelope,
  buildLastTouchAssignedEnvelope,
  buildTouchpointCapturedEnvelope,
} from "./emit.js";
import {
  buildDeltaRecord,
  buildFirstObservationRecord,
  buildSameTupleRecord,
  type TouchpointStore,
} from "./store.js";
import {
  PROCESSOR_NAME,
  PROCESSOR_VERSION,
  buildTouchpointStoreKey,
  decideAttribution,
  resolvePrimaryIdentifier,
} from "./transform.js";
import type { AnalyticsEventEnvelope } from "./types.js";

/**
 * Dependencies for the runtime. The factory accepts already-built
 * consumer/producer so the binary entry point owns lifecycle wiring,
 * tests can inject in-memory fakes, and the runtime stays a pure
 * function of its inputs.
 */
export interface AttributionEngineRuntimeDeps {
  readonly consumer: PolarisConsumer;
  readonly producer: PolarisProducer;
  readonly store: TouchpointStore;
  readonly logger: Logger;
  /**
   * Sync isolation lookup. Defaults to `sharedOnlyIsolationLookup`.
   * Every project flows through the shared topics until the isolation
   * control plane wires the PostgreSQL adapter.
   */
  readonly isolation?: SyncIsolationLookup;
  /**
   * Projects currently isolated for `analytics.events`. The consumer
   * subscribes to their dedicated topics in addition to the shared one.
   */
  readonly isolatedProjects?: ReadonlyArray<string>;
  /** Override for `() => new Date()` so tests can pin emission timestamps. */
  readonly now?: () => Date;
  /** KafkaJS `partitionsConsumedConcurrently`. Forwarded into `runEach`. */
  readonly partitionsConsumedConcurrently?: number;
  /**
   * `ProcessorMetrics` registry. The runtime increments consume / emit /
   * failure counters here. Defaults to a fresh registry so tests still
   * observe their own metrics.
   */
  readonly metrics?: ProcessorMetrics;
  /**
   * Per-run identifier (UUIDv7). Stamped onto every emitted attribution.*
   * event in both the nested `processor.run_id` slot and the property
   * `run_id` field.
   */
  readonly run_id?: string | undefined;
  /**
   * UUIDv7 allocator. Tests inject a deterministic counter; production
   * uses the real `uuidv7()`.
   */
  readonly newEventId?: () => string;
}

/** Runtime handle returned by `createRuntime`. */
export interface AttributionEngineRuntime {
  /** Subscribe and start consuming. Idempotent. */
  start(): Promise<void>;
  /** Stop the underlying consumer. Idempotent. */
  stop(): Promise<void>;
  /**
   * Expose the message handler for direct testing without a running
   * KafkaJS cluster.
   */
  readonly handler: PolarisEachMessageHandler;
  /** Metrics registry the runtime is wired to. */
  readonly metrics: ProcessorMetrics;
  /** In-memory store the runtime is wired to. Mostly for tests. */
  readonly store: TouchpointStore;
}

/**
 * Build the streaming runtime. The factory does not connect the consumer
 * or producer — the binary entry point owns connection lifecycle.
 */
export function createRuntime(deps: AttributionEngineRuntimeDeps): AttributionEngineRuntime {
  const isolation = deps.isolation ?? sharedOnlyIsolationLookup;
  const isolatedProjects = deps.isolatedProjects ?? [];
  const metrics = deps.metrics ?? new ProcessorMetrics();
  const newEventId = deps.newEventId ?? ((): string => uuidv7());

  const handler: PolarisEachMessageHandler = async (payload, context) => {
    await handleMessage({
      payload,
      context,
      producer: deps.producer,
      store: deps.store,
      logger: deps.logger,
      isolation,
      metrics,
      newEventId,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      ...(deps.run_id !== undefined ? { run_id: deps.run_id } : {}),
    });
  };

  let started = false;
  async function start(): Promise<void> {
    if (started) return;
    started = true;
    const topics = consumerTopicsForFamily(TOPIC_FAMILY_ANALYTICS_EVENTS, isolatedProjects);
    await deps.consumer.subscribe({ topics: [...topics], fromBeginning: false });
    deps.logger.info(
      {
        component: "attribution-engine.runtime",
        topics,
        isolated_projects: isolatedProjects,
      },
      "attribution-engine subscribed to analytics.events",
    );
    await deps.consumer.runEach(handler, {
      ...(deps.partitionsConsumedConcurrently !== undefined
        ? { partitionsConsumedConcurrently: deps.partitionsConsumedConcurrently }
        : {}),
    });
  }

  async function stop(): Promise<void> {
    if (!started) return;
    started = false;
    await deps.consumer.disconnect();
  }

  return { start, stop, handler, metrics, store: deps.store };
}

// ---------------------------------------------------------------------------
// Per-message pipeline
// ---------------------------------------------------------------------------

interface HandleMessageInput {
  readonly payload: Parameters<PolarisEachMessageHandler>[0];
  readonly context: PolarisMessageContext;
  readonly producer: PolarisProducer;
  readonly store: TouchpointStore;
  readonly logger: Logger;
  readonly isolation: SyncIsolationLookup;
  readonly metrics: ProcessorMetrics;
  readonly newEventId: () => string;
  readonly now?: () => Date;
  readonly run_id?: string | undefined;
}

async function handleMessage(input: HandleMessageInput): Promise<void> {
  const { payload, context, store, logger, metrics, newEventId } = input;
  const value = payload.message.value;
  if (value === null || value.length === 0) {
    // Tombstone-style empty payload. Drop with a warn — mirrors the
    // other processor runtimes.
    logger.warn(
      {
        component: "attribution-engine.handler",
        topic: payload.topic,
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
      message: "failed to decode analytics.events payload",
    });
    throw err;
  }

  const raw = assertEnvelope(decoded);
  if (raw === undefined) {
    const fail = new Error(
      "attribution-engine: analytics.events payload missing required envelope fields",
    );
    handleClassifiedError(fail, {
      payload,
      context,
      metrics,
      logger,
      message: "analytics.events payload missing required envelope fields",
    });
    throw fail;
  }

  const labels: ProcessorMetricLabels = {
    processor_name: PROCESSOR_NAME,
    processor_version: PROCESSOR_VERSION,
    project_id: raw.project_id,
    environment: raw.environment,
  };
  metrics.incrementConsumed(labels);

  let decision: ReturnType<typeof decideAttribution>;
  try {
    decision = decideAttribution({
      raw,
      prior: getPrior(store, raw),
    });
  } catch (err) {
    handleClassifiedError(err, {
      payload,
      context: { ...context, project_id: raw.project_id, environment: raw.environment },
      metrics,
      logger,
      message: "decideAttribution failed",
    });
    throw err;
  }
  if (decision.kind === "drop") {
    return;
  }

  const startedAt = Date.now();
  const nowFn = input.now ?? ((): Date => new Date());
  const runId = input.run_id ?? buildSyntheticRunId(raw.event_id);

  try {
    // All three decision branches first emit `touchpoint_captured`.
    const touchpointProps: TouchpointCapturedProperties = {
      touchpoint_id: decision.touchpoint_id,
      primary_identifier_kind: decision.primary.kind,
      primary_identifier_value: decision.primary.value,
      campaign: decision.campaign,
      source_event_id: raw.event_id,
      observed_at: raw.occurred_at,
      run_id: runId,
    };
    const touchpointEnvelope = buildTouchpointCapturedEnvelope({
      raw,
      eventId: newEventId(),
      now: nowFn,
      run_id: runId,
      properties: touchpointProps,
    });
    await publishAttributionEnvelope({
      producer: input.producer,
      isolation: input.isolation,
      envelope: touchpointEnvelope,
    });
    metrics.incrementEmitted(labels);

    if (decision.kind === "touchpoint_only") {
      // Same-tuple repeat. Update the store's touchpoint_count and
      // last_observed_at; no further emission.
      const prior = getPrior(store, raw);
      if (prior !== undefined) {
        store.set(
          decision.store_key,
          buildSameTupleRecord({
            prior,
            observed_at: raw.occurred_at,
          }),
        );
      }
      metrics.observeHandlerDurationMs(labels, Date.now() - startedAt);
      logger.debug(
        {
          component: "attribution-engine.handler",
          project_id: raw.project_id,
          environment: raw.environment,
          event_id: raw.event_id,
          touchpoint_id: decision.touchpoint_id,
          source_topic: payload.topic,
        },
        "touchpoint captured (same tuple as prior)",
      );
      return;
    }

    if (decision.kind === "first_observation") {
      const firstProps: FirstTouchAssignedProperties = {
        touchpoint_id: decision.touchpoint_id,
        primary_identifier_kind: decision.primary.kind,
        primary_identifier_value: decision.primary.value,
        campaign: decision.campaign,
        source_event_id: raw.event_id,
        observed_at: raw.occurred_at,
        run_id: runId,
      };
      const firstEnvelope = buildFirstTouchAssignedEnvelope({
        raw,
        eventId: newEventId(),
        now: nowFn,
        run_id: runId,
        properties: firstProps,
      });
      await publishAttributionEnvelope({
        producer: input.producer,
        isolation: input.isolation,
        envelope: firstEnvelope,
      });
      metrics.incrementEmitted(labels);

      const lastProps: LastTouchAssignedProperties = {
        touchpoint_id: decision.touchpoint_id,
        previous_touchpoint_id: null,
        primary_identifier_kind: decision.primary.kind,
        primary_identifier_value: decision.primary.value,
        campaign: decision.campaign,
        source_event_id: raw.event_id,
        observed_at: raw.occurred_at,
        run_id: runId,
      };
      const lastEnvelope = buildLastTouchAssignedEnvelope({
        raw,
        eventId: newEventId(),
        now: nowFn,
        run_id: runId,
        properties: lastProps,
      });
      await publishAttributionEnvelope({
        producer: input.producer,
        isolation: input.isolation,
        envelope: lastEnvelope,
      });
      metrics.incrementEmitted(labels);

      store.set(
        decision.store_key,
        buildFirstObservationRecord({
          project_id: raw.project_id,
          environment: raw.environment,
          primary_identifier_kind: decision.primary.kind,
          primary_identifier_value: decision.primary.value,
          touchpoint_id: decision.touchpoint_id,
          campaign: decision.campaign,
          source_event_id: raw.event_id,
          observed_at: raw.occurred_at,
        }),
      );
      metrics.observeHandlerDurationMs(labels, Date.now() - startedAt);
      logger.debug(
        {
          component: "attribution-engine.handler",
          project_id: raw.project_id,
          environment: raw.environment,
          event_id: raw.event_id,
          touchpoint_id: decision.touchpoint_id,
          first_touch: true,
          source_topic: payload.topic,
        },
        "first touchpoint assigned",
      );
      return;
    }

    // touchpoint_and_last: tuple differs from prior last-touch.
    const lastProps: LastTouchAssignedProperties = {
      touchpoint_id: decision.touchpoint_id,
      previous_touchpoint_id: decision.previous_touchpoint_id,
      primary_identifier_kind: decision.primary.kind,
      primary_identifier_value: decision.primary.value,
      campaign: decision.campaign,
      source_event_id: raw.event_id,
      observed_at: raw.occurred_at,
      run_id: runId,
    };
    const lastEnvelope = buildLastTouchAssignedEnvelope({
      raw,
      eventId: newEventId(),
      now: nowFn,
      run_id: runId,
      properties: lastProps,
    });
    await publishAttributionEnvelope({
      producer: input.producer,
      isolation: input.isolation,
      envelope: lastEnvelope,
    });
    metrics.incrementEmitted(labels);

    const prior = getPrior(store, raw);
    if (prior !== undefined) {
      store.set(
        decision.store_key,
        buildDeltaRecord({
          prior,
          touchpoint_id: decision.touchpoint_id,
          campaign: decision.campaign,
          source_event_id: raw.event_id,
          observed_at: raw.occurred_at,
        }),
      );
    }
    metrics.observeHandlerDurationMs(labels, Date.now() - startedAt);
    logger.debug(
      {
        component: "attribution-engine.handler",
        project_id: raw.project_id,
        environment: raw.environment,
        event_id: raw.event_id,
        touchpoint_id: decision.touchpoint_id,
        previous_touchpoint_id: decision.previous_touchpoint_id,
        source_topic: payload.topic,
      },
      "last-touch reassigned (campaign tuple delta)",
    );
  } catch (err) {
    const classification: ProcessorRetryClassification = classifyError(err);
    metrics.incrementFailed({ ...labels, reason: classification.reason });
    logger.error(
      {
        component: "attribution-engine.handler",
        project_id: raw.project_id,
        environment: raw.environment,
        event_id: raw.event_id,
        source_topic: payload.topic,
        source_partition: payload.partition,
        source_offset: payload.message.offset,
        retry_reason: classification.reason,
        retryable: classification.retryable,
        err: errSummary(err),
      },
      "failed to emit attribution event",
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Publish helper
// ---------------------------------------------------------------------------

/**
 * Publish an attribution envelope to `attribution.events`. Uses the
 * canonical partition-key shape so per-identity ordering is preserved
 * across the analytics → attribution topology — analytics events for a
 * given identifier stay in-order with their attribution outputs.
 */
async function publishAttributionEnvelope(input: {
  readonly producer: PolarisProducer;
  readonly isolation: SyncIsolationLookup;
  readonly envelope: AttributionEventEnvelope;
}): Promise<void> {
  const partitionKey = buildRawEventsPartitionKey({
    project_id: input.envelope.project_id,
    environment: input.envelope.environment,
    event_id: input.envelope.event_id,
    identity: input.envelope.identity,
  });
  await input.producer.publishEvent({
    family: TOPIC_FAMILY_ATTRIBUTION_EVENTS,
    // Same dual-shape stamp as analytics-projector / identity-resolver /
    // sessionizer outputs. The producer wrapper's `PublishableEvent` carries
    // an index signature; the attribution envelope is a closed shape so we
    // widen at the publish boundary.
    event: input.envelope as unknown as Parameters<typeof input.producer.publishEvent>[0]["event"],
    isolation: input.isolation,
    partitionKey,
  });
}

// ---------------------------------------------------------------------------
// Exports for tests / replay
// ---------------------------------------------------------------------------

export type { AttributionEventName, AttributionEventEnvelope };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPrior(
  store: TouchpointStore,
  raw: AnalyticsEventEnvelope,
): ReturnType<TouchpointStore["get"]> {
  // The decision helper builds the store key internally on the decision
  // object. Re-resolving the same key here keeps the pre-decision store
  // lookup explicit. The helpers stay imported once at the top of the file.
  const primary = resolvePrimaryIdentifier(raw.identity);
  if (primary === undefined) return undefined;
  const storeKey = buildTouchpointStoreKey({
    project_id: raw.project_id,
    environment: raw.environment,
    primary,
  });
  return store.get(storeKey);
}

interface ClassifiedErrorContext {
  readonly payload: Parameters<PolarisEachMessageHandler>[0];
  readonly context: PolarisMessageContext;
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
      component: "attribution-engine.handler",
      topic: context.payload.topic,
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

function assertEnvelope(decoded: unknown): AnalyticsEventEnvelope | undefined {
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
  return obj as unknown as AnalyticsEventEnvelope;
}

function errSummary(err: unknown): { name?: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (typeof err === "string") return { message: err };
  return {};
}

/**
 * Synthetic run_id used when the runtime has not been wired to the
 * `ProcessorRunRepository` yet. Derived from the source event id so
 * replays produce the same value, but it is NOT a registered run row.
 * Production bootstrap should pass an explicit `run_id` once the
 * processor-run table is wired in deployment.
 */
function buildSyntheticRunId(sourceEventId: string): string {
  return `synthetic:${sourceEventId}`;
}
