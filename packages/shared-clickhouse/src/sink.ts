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

/** Ingestion interface table for source events (`resolved.events`). */
export const ANALYTICS_QUEUE_TABLE = "analytics_events_queue";

/**
 * Ingestion interface table for derived events (`session.events`,
 * `identity.events`, `attribution.events`, and the profile plane).
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
 * Profile-plane events: `profile.created`, `profile.updated`,
 * `identity.merged`.
 *
 * A third queue rather than more rows in `analytics_processed_queue`. A
 * derived event describes something that HAPPENED; `profile.updated`
 * describes what is now TRUE of a person. Both are conclusions, and only
 * one of them is current state — which decides the engine downstream: a log
 * that keeps every row versus a table that collapses to the latest per
 * person.
 *
 * @see sql/clickhouse/35_profile_events_queue.sql
 */
export const PROFILE_EVENTS_QUEUE_TABLE = "profile_events_queue";

/**
 * The schema-governance quarantine's interface table.
 *
 * A fourth destination with a DIFFERENT row shape, which is why it needs
 * its own insert path rather than a fourth `table` argument: a violation
 * is not an envelope. The event failed validation by definition, so it has
 * no `occurred_at`, may have no `event_id`, and may not be an object.
 */
export const VIOLATIONS_QUEUE_TABLE = "violations_queue";

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

/**
 * One quarantined rejection, as the interface table receives it.
 *
 * `received_at` travels as the ISO-8601 literal the ingester stamped and
 * is parsed by the materialized view, matching how the envelope queues
 * handle their timestamps.
 */
/**
 * One `profile.events` envelope as its interface table receives it.
 *
 * A THIRD shape, and the reason this type exists. `profile_events_queue`
 * does not mirror `analytics_events_queue`: it carries flat `source_id` /
 * `source_type` / `profile_id` columns instead of the envelope's JSON
 * blocks, and none of `identity`, `context`, `consent`, `privacy`,
 * `processor_*` or the transport lineage.
 *
 * The sink pushed `AnalyticsQueueRow` into it until 2026-08-18, on the
 * strength of a comment reading "Both tables have an identical column
 * shape" -- true when it was written, and a third table with a different
 * shape landed after it. ClickHouse dropped the unknown JSON keys and
 * defaulted the missing ones, so every row arrived with `profile_id = ''`
 * and the materialized view's `profile_id != ''` filter discarded all of
 * them. The INSERT succeeded, the metrics counted rows consumed, and
 * `polaris.profiles` stayed empty.
 *
 * Typing it separately is what stops that: same reasoning as
 * `ViolationQueueRow` below, which got it right because a violation is
 * obviously not an envelope. A profile event IS an envelope, just not one
 * this table stores whole -- which is exactly why the mismatch was
 * invisible.
 */
export interface ProfileEventQueueRow {
  readonly event_id: string;
  readonly event: string;
  readonly schema_version: number;
  readonly project_id: string;
  readonly environment: string;
  readonly occurred_at: string;
  readonly ingested_at: string;
  readonly source_id: string;
  readonly source_type: string;
  /**
   * The profile this update is ABOUT, from the envelope's platform-owned
   * `profile` block. The MV keys on it and drops rows where it is empty --
   * a profile event without one names no person and cannot be stored.
   */
  readonly profile_id: string;
  readonly properties: string;
  readonly _version: number;
}

export interface ViolationQueueRow {
  readonly violation_id: string;
  readonly violation_version: number;
  readonly project_id: string;
  readonly environment: string;
  readonly event: string;
  readonly event_id: string;
  readonly schema_version: number;
  readonly reason: string;
  readonly paths: readonly string[];
  readonly redacted_sample: string;
  readonly received_at: string;
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
  /**
   * INSERT a batch of violation records into `violations_queue`.
   *
   * Separate from `insertBatch` because the row shape is different, not
   * because the mechanics are: same client, same settings, same error
   * wrapping. Typing it separately is what stops an envelope row and a
   * violation row from being interchangeable at a call site.
   */
  insertViolations(rows: ReadonlyArray<ViolationQueueRow>): Promise<void>;
  /**
   * INSERT a batch of profile events into `profile_events_queue`.
   *
   * Separate for the same reason as `insertViolations`: the row shape is
   * different, and typing it separately is what stops an envelope row and
   * a profile row from being interchangeable at a call site. They were
   * interchangeable until 2026-08-18, and the compiler had no way to say
   * so because `insertBatch` took a table name as a string.
   */
  insertProfileEvents(rows: ReadonlyArray<ProfileEventQueueRow>): Promise<void>;
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
    async insertProfileEvents(rows): Promise<void> {
      if (rows.length === 0) return;
      try {
        await underlying.insert({
          table: PROFILE_EVENTS_QUEUE_TABLE,
          values: rows,
          format: "JSONEachRow",
          clickhouse_settings: { date_time_input_format: "best_effort" },
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "non-Error cause";
        throw new ClickHouseQueryError(
          `ClickHouse insert into ${database}.${PROFILE_EVENTS_QUEUE_TABLE} failed (${String(
            rows.length,
          )} rows): ${message}`,
          { cause },
        );
      }
      input.logger?.debug(
        { component: "clickhouse.sink", table: PROFILE_EVENTS_QUEUE_TABLE, rows: rows.length },
        "inserted profile event batch",
      );
    },

    async insertViolations(rows): Promise<void> {
      if (rows.length === 0) return;
      try {
        await underlying.insert({
          table: VIOLATIONS_QUEUE_TABLE,
          values: rows,
          format: "JSONEachRow",
          clickhouse_settings: { date_time_input_format: "best_effort" },
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "non-Error cause";
        throw new ClickHouseQueryError(
          `ClickHouse insert into ${database}.${VIOLATIONS_QUEUE_TABLE} failed (${String(
            rows.length,
          )} rows): ${message}`,
          { cause },
        );
      }
      input.logger?.debug(
        { component: "clickhouse.sink", table: VIOLATIONS_QUEUE_TABLE, rows: rows.length },
        "inserted violation batch",
      );
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await underlying.close();
    },
  };
}
