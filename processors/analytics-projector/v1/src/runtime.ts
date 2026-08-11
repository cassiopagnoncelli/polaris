/**
 * Streaming runtime: wires the KafkaJS consumer to the pure transform and
 * the KafkaJS producer.
 *
 * The runtime is intentionally thin and intentionally exposes the
 * underlying KafkaJS plumbing per the architecture's "no full
 * stream-processing framework" rule. It only standardises the glue every
 * processor needs:
 *
 *   1. Subscribe a `PolarisConsumer` to the `raw.events` topic family
 *      (with whatever isolated per-project topics the shared-transport
 *      resolver knows about — empty list in the skeleton).
 *   2. For each message:
 *        - decode the canonical envelope,
 *        - validate the minimum fields the partition-key + producer
 *          wrapper need,
 *        - run the pure transform,
 *        - call `PolarisProducer.publishEvent` with `family:
 *          analytics.events`,
 *        - record consume / emit / failure counters on
 *          `@polaris/shared-processor`'s `ProcessorMetrics`,
 *        - on error: run the shared `classifyError` so the per-message
 *          log line carries the canonical reason code; re-throw so
 *          KafkaJS still applies its own retry semantics.
 *   3. Caller-owned DLQ orchestration: the runtime does not auto-route to
 *      DLQ. Hosts that want DLQ routing wrap the handler with
 *      `publishToDlq` from `@polaris/shared-processor`.
 *
 * The pure transform is exported from `./transform.ts` so the same
 * function is callable by tests, replay tooling (P7-003), and the
 * streaming runtime here.
 */

import type { Logger } from "@polaris/shared-logger";
import {
  classifyError,
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
  STREAM_FAMILY_RAW_EVENTS,
  type SyncIsolationLookup,
  sharedOnlyIsolationLookup,
  type TransportMessageContext,
  type TransportMessageHandler,
} from "@polaris/shared-transport";
import {
  PROCESSOR_NAME,
  PROCESSOR_VERSION,
  type RawEventEnvelope,
  transformToAnalyticsEvent,
} from "./transform.js";

/**
 * Dependencies for the runtime. The factory accepts already-built
 * consumer/producer so the binary entry point owns lifecycle wiring,
 * tests can inject in-memory fakes, and the runtime stays a pure
 * function of its inputs.
 */
export interface AnalyticsProjectorRuntimeDeps {
  readonly consumer: PolarisConsumer;
  readonly producer: PolarisProducer;
  readonly logger: Logger;
  /**
   * `ProcessorMetrics` registry. The runtime increments consume / emit /
   * failure counters here. Defaults to a fresh in-process registry so the
   * processor still observes its own metrics in tests; production wires
   * the registry through `app.ts` so the `/metrics` endpoint can expose
   * the samples.
   */
  /**
   * Sync isolation lookup. Defaults to `sharedOnlyIsolationLookup`, which
   * means every event flows through the shared streams. P11-008 wires the
   * PostgreSQL-backed adapter; until then the default is correct because
   * no project is isolated.
   */
  readonly isolation?: SyncIsolationLookup;
  /**
   * Projects currently isolated for `raw.events`. The consumer must read
   * their dedicated super streams in addition to the shared one (see
   * `consumerFamiliesFor`). Empty by default; the runtime picks up new
   * isolation records on restart, which matches how the shared-transport
   * resolver is designed.
   */
  readonly isolatedProjects?: ReadonlyArray<string>;
  /**
   * Override for `Date.now()` so tests can pin the `ran_at` stamp.
   */
  readonly now?: () => Date;
  readonly metrics?: ProcessorMetrics;
  /**
   * Per-run identifier (UUIDv7). Forwarded into the processor stamp on
   * every emitted event. The runtime accepts the id rather than
   * registering the run itself so the boot layer owns the
   * `ProcessorRunRepository` lifecycle.
   */
  readonly run_id?: string | undefined;
}

/**
 * Runtime handle returned by `createRuntime`. Exposes the lifecycle
 * methods the binary entry point and tests need.
 */
export interface AnalyticsProjectorRuntime {
  /** Subscribe and start consuming. Idempotent. */
  start(): Promise<void>;
  /** Stop the underlying consumer. Idempotent. */
  stop(): Promise<void>;
  /**
   * Expose the message handler for direct testing without a running
   * KafkaJS cluster. The runtime exposes the same handler it registers
   * with `consumer.runEach`, so unit tests can call it with synthetic
   * `EachMessagePayload`-shaped objects.
   */
  readonly handler: TransportMessageHandler;
  /**
   * The `ProcessorMetrics` registry the runtime is wired to. Callers
   * (`app.ts`, tests) can read counters and gauges from it.
   */
  readonly metrics: ProcessorMetrics;
}

/**
 * Build the streaming runtime. The factory does not connect the consumer
 * or producer — the binary entry point owns connection lifecycle so the
 * bootstrap can wire connect into the readiness probe and disconnect
 * into the graceful-shutdown task list.
 */
export function createRuntime(deps: AnalyticsProjectorRuntimeDeps): AnalyticsProjectorRuntime {
  const isolation = deps.isolation ?? sharedOnlyIsolationLookup;
  const isolatedProjects = deps.isolatedProjects ?? [];
  const metrics = deps.metrics ?? new ProcessorMetrics();

  const handler: TransportMessageHandler = async (payload, context) => {
    await handleMessage({
      payload,
      context,
      producer: deps.producer,
      logger: deps.logger,
      isolation,
      metrics,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      ...(deps.run_id !== undefined ? { run_id: deps.run_id } : {}),
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
        component: "analytics-projector.runtime",
        families,
        isolated_projects: isolatedProjects,
      },
      "analytics-projector subscribed to raw.events",
    );
    await deps.consumer.runEach(handler);
  }

  async function stop(): Promise<void> {
    if (!started) return;
    started = false;
    await deps.consumer.disconnect();
  }

  return { start, stop, handler, metrics };
}

// ---------------------------------------------------------------------------
// Per-message pipeline
// ---------------------------------------------------------------------------

interface HandleMessageInput {
  readonly payload: Parameters<TransportMessageHandler>[0];
  readonly context: TransportMessageContext;
  readonly producer: PolarisProducer;
  readonly logger: Logger;
  readonly isolation: SyncIsolationLookup;
  readonly metrics: ProcessorMetrics;
  readonly now?: () => Date;
  readonly run_id?: string | undefined;
}

async function handleMessage(input: HandleMessageInput): Promise<void> {
  const { payload, context, producer, logger, isolation, metrics, now, run_id } = input;
  const value = payload.message.value;
  if (value === null || value.length === 0) {
    // Tombstone-style empty payload. The skeleton drops it with a
    // warn — emitting a tombstone-shaped analytics event would lie to
    // downstream consumers. Real processors with tombstone semantics
    // (e.g. deletion-list filter) are P11 work.
    logger.warn(
      {
        component: "analytics-projector.handler",
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
    // Per shared-transport, decode errors are JSON-parse failures, not
    // schema-level errors. The classifier names the reason
    // (`decode_failed`); we record the metric, log the structured line,
    // and re-throw so KafkaJS surfaces the failure through its own retry
    // path. The host wires DLQ routing via `publishToDlq` if it wants
    // bytes routed to `<processor>.dlq`.
    const classification = classifyError(err);
    metrics.incrementFailed({
      processor_name: PROCESSOR_NAME,
      processor_version: PROCESSOR_VERSION,
      ...(context.project_id !== undefined ? { project_id: context.project_id } : {}),
      ...(context.environment !== undefined ? { environment: context.environment } : {}),
      reason: classification.reason,
    });
    logger.error(
      {
        component: "analytics-projector.handler",
        topic: payload.stream,
        partition: payload.partition,
        offset: payload.message.offset,
        retry_reason: classification.reason,
        retryable: classification.retryable,
        err: errSummary(err),
      },
      "failed to decode raw.events payload",
    );
    throw err;
  }

  const raw = assertEnvelope(decoded);
  if (raw === undefined) {
    const fail = new Error(
      "analytics-projector: raw.events payload missing required envelope fields",
    );
    const classification = classifyError(fail);
    metrics.incrementFailed({
      processor_name: PROCESSOR_NAME,
      processor_version: PROCESSOR_VERSION,
      ...(context.project_id !== undefined ? { project_id: context.project_id } : {}),
      ...(context.environment !== undefined ? { environment: context.environment } : {}),
      reason: classification.reason,
    });
    logger.error(
      {
        component: "analytics-projector.handler",
        topic: payload.stream,
        partition: payload.partition,
        offset: payload.message.offset,
        retry_reason: classification.reason,
        retryable: classification.retryable,
        ...(context.event_id !== undefined ? { event_id: context.event_id } : {}),
      },
      "raw.events payload missing required envelope fields",
    );
    throw fail;
  }

  // Now we know the project/env from the envelope itself — better labels
  // than `context` (which is derived from headers and may be absent).
  const labels: ProcessorMetricLabels = {
    processor_name: PROCESSOR_NAME,
    processor_version: PROCESSOR_VERSION,
    project_id: raw.project_id,
    environment: raw.environment,
  };

  metrics.incrementConsumed(labels);

  const out = transformToAnalyticsEvent(raw, {
    ...(now !== undefined ? { now } : {}),
    ...(run_id !== undefined ? { run_id } : {}),
  });

  // Use the SAME canonical partition key as the source raw.events
  // record so per-identity ordering is preserved end to end. The
  // producer wrapper would compute it from the envelope automatically;
  // calling buildRawEventsPartitionKey explicitly makes the dependency
  // visible in logs and tests, and lets us record it on the structured
  // log line below.
  const partitionKey = buildRawEventsPartitionKey({
    project_id: out.project_id,
    environment: out.environment,
    event_id: out.event_id,
    identity: out.identity,
  });

  const startedAt = Date.now();
  try {
    await producer.publishEvent({
      family: STREAM_FAMILY_ANALYTICS_EVENTS,
      // `PublishableEvent` carries a `[extra: string]: unknown` index
      // signature so producers may attach additional headers/fields. The
      // analytics envelope is a CLOSED shape on purpose (every field is
      // audited), so we widen at the publish boundary rather than
      // polluting the public type.
      event: out as unknown as Parameters<typeof producer.publishEvent>[0]["event"],
      isolation,
      partitionKey,
    });
  } catch (err) {
    const classification: ProcessorRetryClassification = classifyError(err);
    metrics.incrementFailed({ ...labels, reason: classification.reason });
    logger.error(
      {
        component: "analytics-projector.handler",
        project_id: out.project_id,
        environment: out.environment,
        event_id: out.event_id,
        source_topic: payload.stream,
        source_partition: payload.partition,
        source_offset: payload.message.offset,
        retry_reason: classification.reason,
        retryable: classification.retryable,
        err: errSummary(err),
      },
      "failed to publish analytics event",
    );
    throw err;
  }

  metrics.incrementEmitted(labels);
  metrics.observeHandlerDurationMs(labels, Date.now() - startedAt);

  logger.debug(
    {
      component: "analytics-projector.handler",
      project_id: out.project_id,
      environment: out.environment,
      event: out.event,
      event_id: out.event_id,
      schema_version: out.schema_version,
      processor_name: out.processor_name,
      processor_version: out.processor_version,
      ...(run_id !== undefined ? { processor_run_id: run_id } : {}),
      source_topic: payload.stream,
      source_partition: payload.partition,
      source_offset: payload.message.offset,
      partition_key: partitionKey,
    },
    "analytics event emitted",
  );
}

/**
 * Validate the decoded payload has the envelope fields the producer
 * wrapper needs (project_id, environment, event_id, identity, etc.).
 * Returns the narrowed shape, or `undefined` on missing required
 * fields. The skeleton does not run the full canonical envelope Zod
 * validator here — the ingester is authoritative for that, and
 * re-running it on every consumed message would double-validate. We
 * only assert the platform-stamped fields the next pipeline stage
 * actually touches.
 */
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
