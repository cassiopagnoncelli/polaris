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
 * @see consumers/clickhouse-sink/v1
 * @see sql/clickhouse/roles/01_grants.sql
 */

import { type ClickHouseClient as UnderlyingClickHouseClient, createClient } from "@clickhouse/client";
import type { Logger } from "@polaris/shared-logger";
import { ClickHouseConnectionError, ClickHouseQueryError } from "./errors.js";

/** Table the sink writes into. */
export const ANALYTICS_QUEUE_TABLE = "analytics_events_queue";

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
   * INSERT a batch. Resolves only when ClickHouse has acknowledged the
   * write — the sink's checkpoint advance depends on that, so a
   * fire-and-forget insert here would turn at-least-once delivery into
   * silent data loss.
   */
  insertBatch(rows: ReadonlyArray<AnalyticsQueueRow>): Promise<void>;
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
    async insertBatch(rows): Promise<void> {
      if (rows.length === 0) return;
      try {
        await underlying.insert({
          table: ANALYTICS_QUEUE_TABLE,
          values: rows,
          format: "JSONEachRow",
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "non-Error cause";
        throw new ClickHouseQueryError(
          `ClickHouse insert into ${database}.${ANALYTICS_QUEUE_TABLE} failed (${String(rows.length)} rows): ${message}`,
          { cause },
        );
      }
      input.logger?.debug(
        { component: "clickhouse.sink", rows: rows.length },
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
