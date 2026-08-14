/**
 * Analytics ingestion writer.
 *
 * The one place in Polaris that INSERTs into ClickHouse.
 *
 * Until the RabbitMQ migration nothing did: `polaris.analytics_events_queue`
 * was a Kafka Engine table and ClickHouse pulled rows itself. RabbitMQ
 * streams have no ClickHouse engine, so the pull became a push and this
 * module is the push. See `sql/clickhouse/10_analytics_events_queue.sql`
 * for the full rationale.
 *
 * Deliberately separate from `createClickHouseClient`:
 *
 *   - The read profiles (`service`, `operator`) are read-only by grant.
 *     Adding an insert method to them would make "can this client write?"
 *     a runtime question instead of a construction-time one.
 *   - The sink authenticates as its own `polaris_sink` role, whose only
 *     privilege is INSERT on the ingestion interface table. It cannot read
 *     a single row of customer data — which is the correct blast radius
 *     for a process whose whole job is to move bytes in one direction.
 *
 * @see async/warehouse/clickhouse-sink/v1
 * @see sql/clickhouse/roles/01_grants.sql
 */

import {
  createClient,
  type ClickHouseClient as UnderlyingClickHouseClient,
} from "@clickhouse/client";
import type { Logger } from "@polaris/shared-logger";
import { ClickHouseConnectionError, ClickHouseQueryError } from "./errors.js";

/** Ingestion interface table for source events (`analytics.events`). */
export const ANALYTICS_QUEUE_TABLE = "analytics_events_queue";

/**
 * Ingestion interface table for derived events (`enriched.events`,
 * `session.events`, `identity.events`, `attribution.events`).
 *
 * A second table rather than a discriminator column on the first: the
 * sink picks the destination at INSERT time, so each MV downstream stays
 * unfiltered and a routing mistake shows up as rows in the wrong table
 * instead of as quietly inflated counts in `analytics_raw`.
 *
 * @see sql/clickhouse/11_analytics_processed_queue.sql
 */
export const ANALYTICS_PROCESSED_QUEUE_TABLE = "analytics_processed_queue";

/**
 * One row as INSERTed into the ingestion interface table. Field names and
 * types mirror the table's columns exactly; the sink builds these from the
 * canonical envelope plus the transport's lineage.
 *
 * Nested envelope objects travel as JSON strings, matching the column
 * types — the MVs downstream extract what they need.
 */
export interface AnalyticsQueueRow {
  readonly event_id: string;
  readonly event: string;
  readonly schema_version: number;
  readonly project_id: string;
  readonly environment: string;
  readonly occurred_at: string;
  readonly ingested_at: string;
  readonly source: string;
  readonly identity: string;
  readonly context: string;
  readonly consent: string;
  readonly privacy: string;
  readonly properties: string;
  readonly processor_name: string;
  readonly processor_version: string;
  /**
   * The `profile` block as a JSON string, or `""` when the event carries
   * none. The MV extracts `profile_id` / `traits_version` from it into
   * typed columns; the block travels whole so a later reader can reach
   * `traits` without a schema change here.
   */
  readonly profile: string;
  /**
   * ReplacingMergeTree revision. Built by `buildClickHouseVersion` from
   * the producing stage and `ingested_at` — see `version.ts` for why the
   * dual-run makes this load-bearing.
   */
  readonly _version: number;
  /** Concrete partition stream the message came from. */
  readonly _topic: string;
  /** Partition index within the super stream. */
  readonly _partition: number;
  /** RabbitMQ stream offset. */
  readonly _offset: number;
}

export interface CreateAnalyticsSinkWriterInput {
  readonly url: string;
  readonly credential: { readonly username: string; readonly password: string };
  readonly database?: string;
  readonly requestTimeoutMs?: number;
  readonly maxOpenConnections?: number;
  readonly application?: string;
  readonly logger?: Logger;
}

export interface AnalyticsSinkWriter {
  /**
   * INSERT a batch into one of the two ingestion interface tables.
   * Resolves only when ClickHouse has acknowledged the write — the
   * sink's checkpoint advance depends on that, so a fire-and-forget
   * insert here would turn at-least-once delivery into silent data loss.
   *
   * `table` defaults to the source-event queue. Both tables have an
   * identical column shape, which is why one row type and one method
   * serve both paths.
   */
  insertBatch(rows: ReadonlyArray<AnalyticsQueueRow>, table?: string): Promise<void>;
  /** Close the underlying connection pool. Idempotent. */
  close(): Promise<void>;
}

export function createAnalyticsSinkWriter(
  input: CreateAnalyticsSinkWriterInput,
): AnalyticsSinkWriter {
  const database = input.database ?? "polaris";
  let underlying: UnderlyingClickHouseClient;
  try {
    underlying = createClient({
      url: input.url,
      username: input.credential.username,
      password: input.credential.password,
      database,
      application: input.application ?? "polaris-clickhouse-sink",
      max_open_connections: input.maxOpenConnections ?? 4,
      request_timeout: input.requestTimeoutMs ?? 30_000,
      compression: { response: false, request: true },
    });
  } catch (cause) {
    throw new ClickHouseConnectionError("Failed to construct the ClickHouse sink client.", {
      cause,
    });
  }

  let closed = false;

  return {
    async insertBatch(rows, table = ANALYTICS_QUEUE_TABLE): Promise<void> {
      if (rows.length === 0) return;
      try {
        await underlying.insert({
          table,
          values: rows,
          format: "JSONEachRow",
          clickhouse_settings: {
            // `occurred_at` / `ingested_at` arrive as the envelope's
            // ISO-8601 UTC literals (`2026-08-11T10:47:39.315Z`), which is
            // what the canonical event contract specifies and what
            // `AnalyticsQueueRow` declares. ClickHouse's default
            // `date_time_input_format` is `basic`, which accepts neither
            // the `T` separator nor the trailing `Z` — the INSERT fails
            // with CANNOT_PARSE_INPUT_ASSERTION_FAILED on the first row,
            // and because the sink rolls its checkpoint back on a failed
            // batch, every row after it retries forever. `best_effort` is
            // the parser that understands ISO-8601 with a timezone
            // designator.
            date_time_input_format: "best_effort",
          },
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "non-Error cause";
        throw new ClickHouseQueryError(
          `ClickHouse insert into ${database}.${table} failed (${String(rows.length)} rows): ${message}`,
          { cause },
        );
      }
      input.logger?.debug(
        { component: "clickhouse.sink", table, rows: rows.length },
        "inserted analytics batch",
      );
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await underlying.close();
    },
  };
}
