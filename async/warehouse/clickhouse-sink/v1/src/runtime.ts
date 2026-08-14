/**
 * ClickHouse sink runtime.
 *
 * Consumes every canonical super stream and INSERTs batches into one of
 * two ingestion interface tables, which fan them into the materialized
 * views. This service exists because the RabbitMQ migration removed
 * ClickHouse's ability to consume for itself: the Kafka Engine table
 * pulled rows on its own, RabbitMQ streams have no ClickHouse engine,
 * and the AMQP engine that does exist has no offsets and therefore no
 * honest recovery story.
 *
 * ## Routing
 *
 * Polaris streams carry two kinds of fact, and they answer different
 * questions:
 *
 *   analytics.events     what a producer reported   -> analytics_events_queue
 *   enriched.events      \
 *   session.events        \  what Polaris concluded -> analytics_processed_queue
 *   identity.events       /
 *   attribution.events   /
 *
 * The split is made here, at INSERT time, rather than by a WHERE clause
 * in each materialized view. A filter would have to be right in three
 * places and fails silently when it is not — a derived event landing in
 * `analytics_raw` inflates every projection built on it, and nothing in
 * the system would say so. Choosing the table instead makes a routing
 * bug visible as rows in the wrong place.
 *
 * Both tables have an identical column shape, so one `toQueueRow`
 * projection serves both paths; only the destination differs.
 *
 * Until this landed the sink read `analytics.events` alone, which meant
 * every geoip enrichment, session window, identity link and touchpoint
 * the processors computed expired with stream retention without ever
 * becoming queryable.
 *
 * ## Batching
 *
 * ClickHouse wants few large INSERTs. Each INSERT creates a part, and a
 * flood of small parts is the classic way to wedge a MergeTree table. So
 * the runtime accumulates rows and flushes when either bound trips:
 *
 *   - `batchMaxRows` rows are buffered, or
 *   - `batchMaxMs` has elapsed since the batch opened.
 *
 * ## Delivery guarantees
 *
 * At-least-once, and deliberately so:
 *
 *   1. rows accumulate in memory,
 *   2. the batch is INSERTed and ClickHouse acknowledges it,
 *   3. only then does the consumer's checkpoint become durable.
 *
 * A crash between (1) and (3) re-reads the batch from the stream and
 * re-inserts it. `analytics_raw`'s ReplacingMergeTree collapses the
 * duplicates on `(event_id, _version)` — which is exactly what it already
 * did for Kafka-engine redelivery, so the semantics downstream are
 * unchanged.
 *
 * Step (3) needs `DeferredCheckpointStore` to be true. The transport
 * advances a checkpoint as soon as the handler resolves, and this handler
 * resolves for rows that are still only buffered — so without deferral
 * the checkpoint would claim rows ClickHouse never received, and a crash
 * would drop up to `batchMaxRows` of them silently. Wrapping the store
 * holds those positions until the INSERT is acknowledged.
 *
 * The sink is the only consumer that needs this, because it is the only
 * one whose handler defers its side effect.
 *
 * One consequence worth knowing during an incident: the durable position
 * lags the last inserted row by exactly one message. The transport writes
 * a message's checkpoint *after* its handler returns, so the row that
 * triggered a flush is committed with the following batch. The lag errs
 * the safe way — a crash re-reads that row and ReplacingMergeTree
 * collapses the duplicate.
 *
 * The ingest log intentionally keeps duplicates: it records transport
 * truth, and "this batch was delivered twice" is a fact worth being able
 * to see.
 *
 * ## Ordering
 *
 * Per-partition ordering is preserved (the transport serializes handler
 * invocations per partition), but rows from different partitions
 * interleave inside a batch. That is fine: nothing downstream depends on
 * cross-partition order, and ReplacingMergeTree resolves per event key.
 */

import {
  ANALYTICS_PROCESSED_QUEUE_TABLE,
  ANALYTICS_QUEUE_TABLE,
  type AnalyticsQueueRow,
  type AnalyticsSinkWriter,
} from "@polaris/shared-clickhouse";
import type { Logger } from "@polaris/shared-logger";
import {
  consumerFamiliesFor,
  type DeferredCheckpointStore,
  decodeEvent,
  type PolarisConsumer,
  redeliverQueueName,
  STREAM_FAMILY_ANALYTICS_EVENTS,
  STREAM_FAMILY_ATTRIBUTION_EVENTS,
  STREAM_FAMILY_ENRICHED_EVENTS,
  STREAM_FAMILY_IDENTITY_EVENTS,
  STREAM_FAMILY_SESSION_EVENTS,
  type TransportMessageHandler,
  type TransportMessagePayload,
} from "@polaris/shared-transport";

import { SINK_COMPONENT } from "./config.js";
import type { SinkMetrics } from "./metrics.js";

/**
 * Families carrying derived facts. Everything the sink reads that is not
 * `analytics.events` lands in `analytics_processed_queue`.
 */
const DERIVED_STREAM_FAMILIES = [
  STREAM_FAMILY_ENRICHED_EVENTS,
  STREAM_FAMILY_SESSION_EVENTS,
  STREAM_FAMILY_IDENTITY_EVENTS,
  STREAM_FAMILY_ATTRIBUTION_EVENTS,
] as const;

/**
 * True when a delivery came from the source-event family.
 *
 * The `.` prefix check covers per-project isolation: an isolated project
 * reads from `analytics.events.<project_id>`, which is still source
 * events and must still route to `analytics_events_queue`. Matching the
 * bare family alone would silently divert every isolated project's
 * events into the derived table.
 */
function isSourceEventFamily(family: string): boolean {
  return (
    family === STREAM_FAMILY_ANALYTICS_EVENTS ||
    family.startsWith(`${STREAM_FAMILY_ANALYTICS_EVENTS}.`)
  );
}

export interface ClickhouseSinkRuntimeDeps {
  readonly consumer: PolarisConsumer;
  readonly writer: AnalyticsSinkWriter;
  readonly logger: Logger;
  readonly metrics: SinkMetrics;
  /** Flush when this many rows are buffered. */
  readonly batchMaxRows: number;
  /** Flush when the open batch is this old. */
  readonly batchMaxMs: number;
  /**
   * The consumer's checkpoint store, wrapped for deferral. The runtime
   * commits it after each acknowledged INSERT — see the module note on
   * delivery guarantees.
   */
  readonly checkpoints: DeferredCheckpointStore;
  /**
   * Projects currently isolated. Applied to every family the sink reads,
   * not just `analytics.events` — a project isolated for its source
   * events is isolated for its derived events too.
   */
  readonly isolatedProjects?: ReadonlyArray<string>;
  /** Clock seam for tests. */
  readonly now?: () => number;
}

export interface ClickhouseSinkRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Exposed so tests can drive the handler without a broker. */
  readonly handler: TransportMessageHandler;
  /** Flush both open batches immediately. Used by shutdown and by tests. */
  flush(): Promise<void>;
  /** Rows currently buffered across both batches. Tests assert on this. */
  readonly pending: number;
}

export function createRuntime(deps: ClickhouseSinkRuntimeDeps): ClickhouseSinkRuntime {
  const now = deps.now ?? ((): number => Date.now());
  let sourceBatch: AnalyticsQueueRow[] = [];
  let processedBatch: AnalyticsQueueRow[] = [];
  let batchOpenedAt = now();

  /**
   * Flush both batches, then commit once.
   *
   * The single commit is the part that matters. `DeferredCheckpointStore`
   * holds positions for every stream the sink reads, so committing after
   * the first INSERT would advance the derived families' checkpoints past
   * rows still sitting in the second buffer. One commit, after both
   * writes are acknowledged, keeps the durability contract that the
   * module note describes.
   *
   * If the second INSERT fails after the first succeeded, the rollback
   * re-reads both batches. The source rows are then inserted twice and
   * ReplacingMergeTree collapses them — the same at-least-once behaviour
   * a crash mid-batch already produces.
   */
  async function flush(): Promise<void> {
    if (sourceBatch.length === 0 && processedBatch.length === 0) return;
    const sourceRows = sourceBatch;
    const processedRows = processedBatch;
    // Swap the buffers before awaiting so a delivery that lands during the
    // INSERT accumulates into the next batch instead of being lost or
    // double-counted. The held checkpoints are taken in the same breath, so
    // the snapshot covers exactly these rows — a position written by another
    // partition mid-INSERT belongs to the next batch, not this one.
    sourceBatch = [];
    processedBatch = [];
    const held = deps.checkpoints.take();
    batchOpenedAt = now();
    const started = now();
    try {
      if (sourceRows.length > 0) {
        await deps.writer.insertBatch(sourceRows, ANALYTICS_QUEUE_TABLE);
      }
      if (processedRows.length > 0) {
        await deps.writer.insertBatch(processedRows, ANALYTICS_PROCESSED_QUEUE_TABLE);
      }
    } catch (err) {
      // Put these positions back so the transport re-reads these rows
      // rather than resuming past them.
      deps.checkpoints.restore(held);
      throw err;
    }
    // The rows are durable in ClickHouse; the positions may follow.
    await deps.checkpoints.commit(held);
    const duration = now() - started;
    if (sourceRows.length > 0) {
      deps.metrics.recordBatch(sourceRows.length, duration, ANALYTICS_QUEUE_TABLE);
    }
    if (processedRows.length > 0) {
      deps.metrics.recordBatch(processedRows.length, duration, ANALYTICS_PROCESSED_QUEUE_TABLE);
    }
    deps.logger.debug(
      {
        component: "clickhouse-sink.flush",
        rows: sourceRows.length,
        processed_rows: processedRows.length,
        duration_ms: duration,
      },
      "flushed batch to clickhouse",
    );
  }

  const handler: TransportMessageHandler = async (payload) => {
    const row = toQueueRow(payload, deps.logger);
    if (row === undefined) {
      deps.metrics.recordSkipped();
      return;
    }
    const source = isSourceEventFamily(payload.family);
    const table = source ? ANALYTICS_QUEUE_TABLE : ANALYTICS_PROCESSED_QUEUE_TABLE;
    if (source) {
      sourceBatch.push(row);
    } else {
      processedBatch.push(row);
    }
    deps.metrics.recordConsumed(row.project_id, row.environment, table);
    deps.metrics.recordLag(row.ingested_at, now(), table);

    const full = sourceBatch.length + processedBatch.length >= deps.batchMaxRows;
    const stale = now() - batchOpenedAt >= deps.batchMaxMs;
    if (full || stale) {
      // Awaiting here is what makes the checkpoint safe: the transport
      // advances the offset only after this handler resolves, so the rows
      // are durable in ClickHouse before the position moves past them.
      await flush();
    }
  };

  let started = false;
  let ticker: NodeJS.Timeout | undefined;

  async function start(): Promise<void> {
    if (started) return;
    started = true;
    const isolated = deps.isolatedProjects ?? [];
    const families = [STREAM_FAMILY_ANALYTICS_EVENTS, ...DERIVED_STREAM_FAMILIES].flatMap(
      (family) => [...consumerFamiliesFor(family, isolated)],
    );
    await deps.consumer.subscribe({
      families,
      queues: [redeliverQueueName(SINK_COMPONENT)],
    });
    deps.logger.info(
      { component: "clickhouse-sink.runtime", families, batch_max_rows: deps.batchMaxRows },
      "clickhouse sink subscribed to source and derived event streams",
    );
    await deps.consumer.runEach(handler);

    // A low-traffic partition would otherwise hold rows until the next
    // message arrives, which could be minutes. The ticker bounds that.
    ticker = setInterval(
      () => {
        if (sourceBatch.length === 0 && processedBatch.length === 0) return;
        if (now() - batchOpenedAt < deps.batchMaxMs) return;
        void flush().catch((err: unknown) => {
          const error = err as Error;
          deps.logger.error(
            {
              component: "clickhouse-sink.flush",
              err: { name: error.name, message: error.message },
            },
            "timed batch flush failed; rows stay buffered for the next attempt",
          );
        });
      },
      Math.max(deps.batchMaxMs, 250),
    );
    ticker.unref?.();
  }

  async function stop(): Promise<void> {
    if (!started) return;
    started = false;
    if (ticker !== undefined) clearInterval(ticker);
    // Stop consuming first, then flush what is buffered, so shutdown does
    // not race a delivery into a batch nobody will write.
    await deps.consumer.disconnect();
    await flush();
  }

  return {
    start,
    stop,
    handler,
    flush,
    get pending(): number {
      return sourceBatch.length + processedBatch.length;
    },
  };
}

/**
 * Project a delivered message onto an ingestion row.
 *
 * Returns `undefined` for a payload that cannot be a canonical envelope.
 * Skipping beats throwing: a malformed message would otherwise rewind the
 * partition and re-deliver forever, stalling ingestion for every healthy
 * event behind it.
 */
export function toQueueRow(
  payload: TransportMessagePayload,
  logger: Logger,
): AnalyticsQueueRow | undefined {
  const value = payload.message.value;
  if (value === null || value.length === 0) return undefined;

  let decoded: unknown;
  try {
    decoded = decodeEvent(value);
  } catch (err) {
    const error = err as Error;
    logger.warn(
      {
        component: "clickhouse-sink.decode",
        stream: payload.stream,
        offset: payload.message.offset,
        err: { name: error.name, message: error.message },
      },
      "skipping undecodable analytics.events payload",
    );
    return undefined;
  }

  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return undefined;
  const envelope = decoded as Record<string, unknown>;

  const eventId = str(envelope["event_id"]);
  const event = str(envelope["event"]);
  const projectId = str(envelope["project_id"]);
  const environment = str(envelope["environment"]);
  const occurredAt = str(envelope["occurred_at"]);
  const ingestedAt = str(envelope["ingested_at"]);
  if (
    eventId === undefined ||
    event === undefined ||
    projectId === undefined ||
    environment === undefined ||
    occurredAt === undefined ||
    ingestedAt === undefined
  ) {
    logger.warn(
      {
        component: "clickhouse-sink.decode",
        stream: payload.stream,
        offset: payload.message.offset,
      },
      "skipping analytics.events payload missing required envelope fields",
    );
    return undefined;
  }

  const processor = asRecord(envelope["processor"]);
  return {
    event_id: eventId,
    event,
    schema_version: num(envelope["schema_version"]) ?? 1,
    project_id: projectId,
    environment,
    // ClickHouse's best_effort DateTime parser accepts the canonical
    // ISO-8601 `...Z` shape the envelope carries.
    occurred_at: occurredAt,
    ingested_at: ingestedAt,
    source: json(envelope["source"]),
    identity: json(envelope["identity"]),
    context: json(envelope["context"]),
    consent: json(envelope["consent"]),
    privacy: json(envelope["privacy"]),
    properties: json(envelope["properties"]),
    processor_name: str(processor?.["name"]) ?? "",
    processor_version: str(processor?.["version"]) ?? "",
    // The MVs fall back to the ingest timestamp when this is 0, so an
    // envelope without an explicit version still collapses monotonically.
    _version: num(envelope["_version"]) ?? 0,
    _topic: payload.stream,
    _partition: payload.partition,
    _offset: Number(payload.message.offset),
  };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Nested envelope objects travel to ClickHouse as JSON strings, matching
 * the `String` columns on the ingestion interface table. An absent object
 * becomes `''` rather than `'null'` so downstream `JSONExtract` calls see
 * an empty value instead of a literal null.
 */
function json(value: unknown): string {
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}
