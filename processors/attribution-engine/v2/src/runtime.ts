/**
 * Streaming runtime: wires KafkaJS consumer → pure transform → KafkaJS
 * producer, with the touchpoint store layered between.
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
 * in-memory adapter and production wires the PostgreSQL-backed one
 * (ADR 0005). The store lookup sits in its own try/catch, separate from
 * the transform's: a database fault is infrastructure, and labelling it
 * "decideAttribution failed" would send whoever is on call to the wrong
 * file.
 *
 * Topic strategy: `attribution.events` is already a canonical topic
 * family in `@polaris/shared-transport`, so the runtime publishes via the
 * producer's `publishEvent` helper (mirrors the identity-resolver
 * pattern).
 *
 * Caller-owned DLQ orchestration: the runtime does not auto-route to
 * DLQ. Hosts that want DLQ routing wrap the handler with `publishToDlq`
 * from `@polaris/shared-processor`.
 */

import type { Logger } from "@polaris/shared-logger";
import {
  ALWAYS_ENABLED_GATE,
  classifyError,
  createLagReporter,
  deriveEventId,
  type LagReporter,
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
  STREAM_FAMILY_ANALYTICS_EVENTS,
  STREAM_FAMILY_ATTRIBUTION_EVENTS,
  type SyncIsolationLookup,
  sharedOnlyIsolationLookup,
  type TransportMessageContext,
  type TransportMessageHandler,
} from "@polaris/shared-transport";

import {
  type AttributionEventEnvelope,
  type AttributionEventName,
  buildFirstTouchAssignedEnvelope,
  buildLastTouchAssignedEnvelope,
  buildTouchpointCapturedEnvelope,
  type FirstTouchAssignedProperties,
  type LastTouchAssignedProperties,
  type TouchpointCapturedProperties,
} from "./emit.js";
import {
  buildDeltaRecord,
  buildFirstObservationRecord,
  buildSameTupleRecord,
  type TouchpointStore,
} from "./store.js";
import {
  buildTouchpointStoreKey,
  DEFAULT_ATTRIBUTION_WINDOW_SECONDS,
  decideAttribution,
  PROCESSOR_NAME,
  PROCESSOR_VERSION,
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
  /**
   * `ProcessorMetrics` registry. The runtime increments consume / emit /
   * failure counters here. Defaults to a fresh registry so tests still
   * observe their own metrics.
   */
  readonly metrics?: ProcessorMetrics;
  /**
   * Lag reporter. Defaults to one owned by this runtime; `app.ts` passes its
   * own so it can stop the timer on shutdown.
   */
  readonly lag?: LagReporter;
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
   * Event-id allocator override. Tests inject a deterministic counter;
   * production leaves it unset and gets ids derived from the source event
   * (see `derivedEventId` below), NOT random ones.
   */
  readonly newEventId?: () => string;
  /**
   * Inactivity window in seconds. Defaults to the manifest value.
   *
   * There is deliberately NO env var behind this. The window is a
   * semantic rule, and per the manifest header PostgreSQL and env carry
   * runtime configuration, never semantic transformation rules — a knob
   * here would let a deployment silently change which events receive
   * first touch, which is the exact drift processor versioning exists to
   * prevent. Changing the window means a v3.
   *
   * The seam exists so tests can pin a small window without waiting 90
   * days.
   */
  readonly window_seconds?: number;
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
  readonly handler: TransportMessageHandler;
  /** Metrics registry the runtime is wired to. */
  readonly metrics: ProcessorMetrics;
  /** Store the runtime is wired to. Mostly for tests. */
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
  const gate = deps.gate ?? ALWAYS_ENABLED_GATE;
  const lag =
    deps.lag ??
    createLagReporter({ metrics, identity: { name: PROCESSOR_NAME, version: PROCESSOR_VERSION } });
  const newEventId = deps.newEventId;
  const windowSeconds = deps.window_seconds ?? DEFAULT_ATTRIBUTION_WINDOW_SECONDS;

  const handler: TransportMessageHandler = async (payload, context) => {
    await handleMessage({
      payload,
      context,
      producer: deps.producer,
      store: deps.store,
      logger: deps.logger,
      isolation,
      metrics,
      gate,
      lag,
      ...(newEventId !== undefined ? { newEventId } : {}),
      windowSeconds,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      run_id: deps.run_id,
    });
  };

  let started = false;
  async function start(): Promise<void> {
    if (started) return;
    started = true;
    const families = consumerFamiliesFor(STREAM_FAMILY_ANALYTICS_EVENTS, isolatedProjects);
    await deps.consumer.subscribe({ families: [...families] });
    deps.logger.info(
      {
        component: "attribution-engine.runtime",
        families,
        isolated_projects: isolatedProjects,
      },
      "attribution-engine subscribed to analytics.events",
    );
    await deps.consumer.runEach(handler);
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
  readonly payload: Parameters<TransportMessageHandler>[0];
  readonly context: TransportMessageContext;
  readonly producer: PolarisProducer;
  readonly store: TouchpointStore;
  readonly logger: Logger;
  readonly isolation: SyncIsolationLookup;
  readonly metrics: ProcessorMetrics;
  /** Activation gate, consulted once the envelope's scope is known. */
  readonly gate: ProcessorActivationGate;
  /** Records when this partition last delivered, for the lag timer. */
  readonly lag: LagReporter;
  readonly newEventId?: (() => string) | undefined;
  readonly windowSeconds: number;
  readonly now?: () => Date;
  /** Run emitting these events. Threaded down from `createRuntime`'s deps. */
  readonly run_id: string;
}

async function handleMessage(input: HandleMessageInput): Promise<void> {
  const { payload, context, store, logger, metrics, gate, newEventId, lag } = input;
  const value = payload.message.value;
  if (value === null || value.length === 0) {
    // Tombstone-style empty payload. Drop with a warn — mirrors the
    // other processor runtimes.
    logger.warn(
      {
        component: "attribution-engine.handler",
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
        component: "attribution-engine.handler",
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

  // Records WHEN, not lag itself: the timer computes `now - this`, so the
  // reading keeps climbing when messages stop arriving.
  lag.observe({
    family: payload.family,
    partition: payload.partition,
    project_id: raw.project_id,
    environment: raw.environment,
    ingestedAt: raw.ingested_at,
  });
  metrics.incrementConsumed(labels);

  /**
   * Deterministic id for a derived event.
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

  // Read the prior chain before deciding, and in its own try: the store
  // is a database call now (ADR 0005), so a failure here is an
  // infrastructure fault, not a transform fault. Folding it into the
  // decision's catch below would label a Postgres outage
  // "decideAttribution failed" and send whoever is on call to the wrong
  // file.
  let prior: Awaited<ReturnType<TouchpointStore["get"]>>;
  try {
    prior = await getPrior(store, raw);
  } catch (err) {
    handleClassifiedError(err, {
      payload,
      context: { ...context, project_id: raw.project_id, environment: raw.environment },
      metrics,
      logger,
      message: "touchpoint chain lookup failed",
    });
    throw err;
  }

  let decision: ReturnType<typeof decideAttribution>;
  try {
    decision = decideAttribution({ raw, prior, window_seconds: input.windowSeconds });
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
  const runId = input.run_id;

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
      eventId: derivedEventId("touchpoint"),
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
      const prior = await getPrior(store, raw);
      if (prior !== undefined) {
        await store.set(
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
          source_topic: payload.stream,
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
        eventId: derivedEventId("first_touch"),
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
        eventId: derivedEventId("last_touch"),
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

      // startChain, not set: this branch fires both for a genuinely new
      // identifier AND for one whose chain the window just expired. In the
      // second case `set` would refuse to rewrite the first-touch slot —
      // correct for a continuing chain, wrong for a restarted one — and
      // leave the row anchored to the expired chain's first touch.
      await store.startChain(
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
          source_topic: payload.stream,
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
      eventId: derivedEventId("last_touch"),
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

    const prior = await getPrior(store, raw);
    if (prior !== undefined) {
      await store.set(
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
        source_topic: payload.stream,
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
        source_topic: payload.stream,
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
    family: STREAM_FAMILY_ATTRIBUTION_EVENTS,
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

export type { AttributionEventEnvelope, AttributionEventName };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getPrior(
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
  return await store.get(storeKey);
}

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
      component: "attribution-engine.handler",
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
