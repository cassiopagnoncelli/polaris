/**
 * Streaming runtime: wires KafkaJS consumer → enricher → KafkaJS
 * producer.
 *
 * Shape mirrors `processors/identity-resolver/v1/src/runtime.ts` and
 * `processors/analytics-projector/v1/src/runtime.ts` so every Polaris
 * processor uses the same per-message contract:
 *
 *   1. Subscribe a `PolarisConsumer` to the `raw.events` topic family
 *      (plus any isolated per-project topics).
 *
 *   2. For each message:
 *        - decode the canonical envelope,
 *        - validate the minimum envelope fields the enricher needs,
 *        - run the pure `decideEnrichment` transform against the
 *          configured `IPLookup` backend,
 *        - build the canonical `enriched.geoip` envelope,
 *        - publish to `enriched.events` via `PolarisProducer`,
 *        - record consume / emit / failure counters on
 *          `@polaris/shared-processor`'s `ProcessorMetrics`,
 *        - on error: classify via the shared `classifyError`, increment
 *          the failed counter, and re-throw so KafkaJS surfaces the
 *          failure through its own retry path.
 *
 * The runtime never opens database connections itself. It accepts the
 * `IPLookup` adapter as a dependency so tests inject `InMemoryIPLookup`
 * and production wires either `NoOpIPLookup` (fail-open default) or a
 * future `MaxmindIPLookup` (out of scope for v1).
 *
 * Caller-owned DLQ orchestration: the runtime does not auto-route to
 * DLQ. Hosts that want DLQ routing wrap the handler with
 * `publishToDlq` from `@polaris/shared-processor`.
 *
 * PII posture: every log line in this runtime uses the source IP's
 * SHA-256 hash, never the raw IP. The `assertEnvelope` guard preserves
 * the original `context.ip` value on the in-memory envelope so the
 * transform can read it, but `handleMessage` never includes it in a
 * structured log line. Even at debug level the runtime only logs
 * `source_ip_hash`.
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
  STREAM_FAMILY_ENRICHED_EVENTS,
  STREAM_FAMILY_RAW_EVENTS,
  type SyncIsolationLookup,
  sharedOnlyIsolationLookup,
  type TransportMessageContext,
  type TransportMessageHandler,
} from "@polaris/shared-transport";

import { buildGeoipEnvelope, type GeoipEnvelope } from "./emit.js";
import type { IPLookup } from "./lookup.js";
import { NoOpIPLookup } from "./lookup.js";
import {
  decideEnrichment,
  decisionToProperties,
  PROCESSOR_IDENTITY,
  PROCESSOR_NAME,
  PROCESSOR_VERSION,
} from "./transform.js";
import type { RawEventEnvelope } from "./types.js";

/**
 * Dependencies for the runtime. The factory accepts an already-built
 * consumer/producer so the binary entry point owns lifecycle wiring,
 * tests can inject in-memory fakes, and the runtime stays a pure
 * function of its inputs.
 */
export interface GeoipEnricherRuntimeDeps {
  readonly consumer: PolarisConsumer;
  readonly producer: PolarisProducer;
  readonly logger: Logger;
  /**
   * IP-to-geo backend. Defaults to `NoOpIPLookup` so a misconfigured
   * deployment fails open rather than stalling the streaming pipeline.
   * Tests inject `InMemoryIPLookup`; production wires the MaxMind
   * adapter when it lands.
   */
  readonly lookup?: IPLookup;
  /**
   * Sync isolation lookup. Defaults to `sharedOnlyIsolationLookup`.
   * Every project flows through the shared topics until the isolation
   * control plane (P11-008) wires the PostgreSQL adapter.
   */
  readonly isolation?: SyncIsolationLookup;
  /**
   * Projects currently isolated for `raw.events`. The consumer
   * subscribes to their dedicated topics in addition to the shared one.
   */
  readonly isolatedProjects?: ReadonlyArray<string>;
  /** Override for `Date.now()` so tests can pin emission timestamps. */
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
}

/** Runtime handle returned by `createRuntime`. */
export interface GeoipEnricherRuntime {
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
  /** Lookup adapter the runtime is wired to. */
  readonly lookup: IPLookup;
}

/**
 * Build the streaming runtime. The factory does not connect the
 * consumer or producer — the binary entry point owns connection
 * lifecycle.
 */
export function createRuntime(deps: GeoipEnricherRuntimeDeps): GeoipEnricherRuntime {
  const isolation = deps.isolation ?? sharedOnlyIsolationLookup;
  const isolatedProjects = deps.isolatedProjects ?? [];
  const metrics = deps.metrics ?? new ProcessorMetrics();
  const gate = deps.gate ?? ALWAYS_ENABLED_GATE;
  const lookup = deps.lookup ?? new NoOpIPLookup();
  // No uuidv7 fallback: absence means "derive the id from the cause",
  // which is the production path. Tests inject a counter.
  const newEventId = deps.newEventId;

  const handler: TransportMessageHandler = async (payload, context) => {
    await handleMessage({
      payload,
      context,
      producer: deps.producer,
      lookup,
      logger: deps.logger,
      isolation,
      metrics,
      gate,
      ...(newEventId !== undefined ? { newEventId } : {}),
      run_id: deps.run_id,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
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
        component: "geoip-enricher.runtime",
        families,
        isolated_projects: isolatedProjects,
        ip_lookup: lookup.id,
      },
      "geoip-enricher subscribed to raw.events",
    );
    await deps.consumer.runEach(handler);
  }

  async function stop(): Promise<void> {
    if (!started) return;
    started = false;
    await deps.consumer.disconnect();
  }

  return { start, stop, handler, metrics, lookup };
}

// ---------------------------------------------------------------------------
// Per-message pipeline
// ---------------------------------------------------------------------------

interface HandleMessageInput {
  readonly payload: Parameters<TransportMessageHandler>[0];
  readonly context: TransportMessageContext;
  readonly producer: PolarisProducer;
  readonly lookup: IPLookup;
  readonly logger: Logger;
  readonly isolation: SyncIsolationLookup;
  readonly metrics: ProcessorMetrics;
  /** Activation gate, consulted once the envelope's scope is known. */
  readonly gate: ProcessorActivationGate;
  readonly newEventId?: (() => string) | undefined;
  readonly run_id: string;
  readonly now?: () => Date;
}

async function handleMessage(input: HandleMessageInput): Promise<void> {
  const {
    payload,
    context,
    producer,
    lookup,
    logger,
    isolation,
    metrics,
    newEventId,
    run_id,
    now,
    gate,
  } = input;
  const value = payload.message.value;
  if (value === null || value.length === 0) {
    // Tombstone-style empty payload. Drop with a warn — see the
    // analytics-projector runtime for the same rationale.
    logger.warn(
      {
        component: "geoip-enricher.handler",
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
    const fail = new Error("geoip-enricher: raw.events payload missing required envelope fields");
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
        component: "geoip-enricher.handler",
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

  const startedAt = Date.now();
  const decision = decideEnrichment({ ip: raw.context.ip, lookup });
  const properties = decisionToProperties(decision, {
    source_event_id: raw.event_id,
    run_id,
  });

  const envelope: GeoipEnvelope = buildGeoipEnvelope({
    raw,
    properties,
    eventId: derivedEventId("enriched"),
    now: now ?? ((): Date => new Date()),
    run_id,
  });

  // Reuse the SAME canonical partition key as the source raw.events
  // record so per-identity ordering is preserved end to end (same
  // pattern as analytics-projector and identity-resolver).
  const partitionKey = buildRawEventsPartitionKey({
    project_id: envelope.project_id,
    environment: envelope.environment,
    event_id: envelope.event_id,
    identity: envelope.identity,
  });

  try {
    await producer.publishEvent({
      family: STREAM_FAMILY_ENRICHED_EVENTS,
      // The enriched envelope is a closed shape on purpose; widen at
      // the producer boundary so `PublishableEvent`'s index signature
      // does not pollute the local type.
      event: envelope as unknown as Parameters<typeof producer.publishEvent>[0]["event"],
      isolation,
      partitionKey,
    });
  } catch (err) {
    const classification: ProcessorRetryClassification = classifyError(err);
    metrics.incrementFailed({ ...labels, reason: classification.reason });
    logger.error(
      {
        component: "geoip-enricher.handler",
        project_id: envelope.project_id,
        environment: envelope.environment,
        event_id: envelope.event_id,
        source_event_id: raw.event_id,
        source_topic: payload.stream,
        source_partition: payload.partition,
        source_offset: payload.message.offset,
        retry_reason: classification.reason,
        retryable: classification.retryable,
        // No raw IP in logs — never. The hash (if any) was already
        // stamped on the envelope.
        source_ip_hash: decision.source_ip_hash,
        geo_source: decision.source,
        err: errSummary(err),
      },
      "failed to publish enriched.geoip event",
    );
    throw err;
  }

  metrics.incrementEmitted(labels);
  metrics.observeHandlerDurationMs(labels, Date.now() - startedAt);

  logger.debug(
    {
      component: "geoip-enricher.handler",
      project_id: envelope.project_id,
      environment: envelope.environment,
      event: envelope.event,
      event_id: envelope.event_id,
      source_event_id: raw.event_id,
      source_topic: payload.stream,
      source_partition: payload.partition,
      source_offset: payload.message.offset,
      partition_key: partitionKey,
      // NEVER log the raw IP. Only the hash and the lookup backend.
      source_ip_hash: decision.source_ip_hash,
      geo_source: decision.source,
      country_code: decision.country_code,
    },
    "enriched.geoip emitted",
  );
}

export { PROCESSOR_IDENTITY, PROCESSOR_NAME, PROCESSOR_VERSION };

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
      component: "geoip-enricher.handler",
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
