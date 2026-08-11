/**
 * ClickHouse sink runtime.
 *
 * Consumes the `analytics.events` super stream and INSERTs batches into
 * `polaris.analytics_events_queue`, which fans them into the two
 * materialized views. This service exists because the RabbitMQ migration
 * removed ClickHouse's ability to consume for itself: the Kafka Engine
 * table pulled rows on its own, RabbitMQ streams have no ClickHouse
 * engine, and the AMQP engine that does exist has no offsets and
 * therefore no honest recovery story.
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

import type { AnalyticsQueueRow, AnalyticsSinkWriter } from "@polaris/shared-clickhouse";
import type { Logger } from "@polaris/shared-logger";
import {
  consumerFamiliesFor,
  type DeferredCheckpointStore,
  decodeEvent,
  type PolarisConsumer,
  redeliverQueueName,
  STREAM_FAMILY_ANALYTICS_EVENTS,
  type TransportMessageHandler,
  type TransportMessagePayload,
} from "@polaris/shared-transport";

import { SINK_COMPONENT } from "./config.js";
import type { SinkMetrics } from "./metrics.js";

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
  /** Projects currently isolated for `analytics.events`. */
  readonly isolatedProjects?: ReadonlyArray<string>;
  /** Clock seam for tests. */
  readonly now?: () => number;
}

export interface ClickhouseSinkRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Exposed so tests can drive the handler without a broker. */
  readonly handler: TransportMessageHandler;
  /** Flush the open batch immediately. Used by shutdown and by tests. */
  flush(): Promise<void>;
  /** Rows currently buffered. Tests assert on this. */
  readonly pending: number;
}

export function createRuntime(deps: ClickhouseSinkRuntimeDeps): ClickhouseSinkRuntime {
  const now = deps.now ?? ((): number => Date.now());
  let batch: AnalyticsQueueRow[] = [];
  let batchOpenedAt = now();

  async function flush(): Promise<void> {
    if (batch.length === 0) return;
    const rows = batch;
    // Swap the buffer before awaiting so a delivery that lands during the
    // INSERT accumulates into the next batch instead of being lost or
    // double-counted.
    batch = [];
    batchOpenedAt = now();
    const started = now();
    try {
      await deps.writer.insertBatch(rows);
    } catch (err) {
      // Drop the held positions so the transport re-reads these rows
      // rather than resuming past them.
      deps.checkpoints.rollback();
      throw err;
    }
    // The rows are durable in ClickHouse; the positions may follow.
    await deps.checkpoints.commit();
    deps.metrics.recordBatch(rows.length, now() - started);
    deps.logger.debug(
      { component: "clickhouse-sink.flush", rows: rows.length, duration_ms: now() - started },
      "flushed batch to clickhouse",
    );
  }

  const handler: TransportMessageHandler = async (payload) => {
    const row = toQueueRow(payload, deps.logger);
    if (row === undefined) {
      deps.metrics.recordSkipped();
      return;
    }
    batch.push(row);
    deps.metrics.recordConsumed(row.project_id, row.environment);
    deps.metrics.recordLag(row.ingested_at, now());

    const full = batch.length >= deps.batchMaxRows;
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
    const families = consumerFamiliesFor(
      STREAM_FAMILY_ANALYTICS_EVENTS,
      deps.isolatedProjects ?? [],
    );
    await deps.consumer.subscribe({
      families: [...families],
      queues: [redeliverQueueName(SINK_COMPONENT)],
    });
    deps.logger.info(
      { component: "clickhouse-sink.runtime", families, batch_max_rows: deps.batchMaxRows },
      "clickhouse sink subscribed to analytics.events",
    );
    await deps.consumer.runEach(handler);

    // A low-traffic partition would otherwise hold rows until the next
    // message arrives, which could be minutes. The ticker bounds that.
    ticker = setInterval(
      () => {
        if (batch.length === 0) return;
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
      return batch.length;
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
