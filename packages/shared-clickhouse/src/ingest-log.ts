/**
 * Typed reader for `polaris.analytics_ingest_log`.
 *
 * The ingest log is the append-only record of what ClickHouse consumed from
 * the Kafka Engine table. Duplicates are expected and diagnostic — see
 * `docs/architecture/07-clickhouse.md` "Two-Layer Raw Storage". This reader
 * does NOT dedupe; it returns rows as ClickHouse persists them.
 *
 * Both service and operator profiles get this reader. The underlying role
 * grant for `polaris_service` allows SELECT on this table.
 */

import type { ClickHouseClient as UnderlyingClickHouseClient } from "@clickhouse/client";
import { runQuery } from "./internal/exec.js";
import { assertNoFinal, bindScalar } from "./internal/sql.js";
import type {
  AnalyticsIngestLogRow,
  IngestLogFilter,
  IngestLogTraceFilter,
  IngestLogTraceRow,
} from "./types.js";

export interface IngestLogReader {
  inspect(filter: IngestLogFilter): Promise<AnalyticsIngestLogRow[]>;
  /**
   * Every ingest-log row for one `event_id`, oldest first.
   *
   * Ordered ASC, unlike `inspect`: a trace is read as a timeline, and a
   * timeline that runs backwards has to be re-read to be understood.
   * Multiple rows are normal and diagnostic — the table is append-only
   * and does not dedupe, so a duplicate delivery shows up as what it is.
   */
  trace(filter: IngestLogTraceFilter): Promise<IngestLogTraceRow[]>;
}

/** Hard cap on rows one trace returns. */
export const INGEST_LOG_TRACE_MAX_LIMIT = 500;

export function createIngestLogReader(input: {
  underlying: UnderlyingClickHouseClient;
}): IngestLogReader {
  const { underlying } = input;

  return {
    async inspect(filter) {
      const limit = filter.limit ?? 100;
      if (!Number.isInteger(limit) || limit <= 0 || limit > 10_000) {
        throw new Error("ingestLog.inspect: limit must be an integer in [1, 10000].");
      }

      const params: Record<string, unknown> = {
        project_id: filter.projectId,
        limit,
      };
      const where: string[] = ["project_id = " + bindScalar("project_id", "String")];

      if (filter.environment !== undefined) {
        params["environment"] = filter.environment;
        where.push("environment = " + bindScalar("environment", "String"));
      }
      if (filter.event !== undefined) {
        params["event"] = filter.event;
        where.push("event = " + bindScalar("event", "String"));
      }
      if (filter.eventId !== undefined) {
        params["event_id"] = filter.eventId;
        where.push("event_id = " + bindScalar("event_id", "String"));
      }
      if (filter.ingestedFrom !== undefined) {
        params["ingested_from"] = filter.ingestedFrom;
        where.push(
          "ingested_at >= parseDateTime64BestEffort(" +
            bindScalar("ingested_from", "String") +
            ", 3, 'UTC')",
        );
      }
      if (filter.ingestedTo !== undefined) {
        params["ingested_to"] = filter.ingestedTo;
        where.push(
          "ingested_at < parseDateTime64BestEffort(" +
            bindScalar("ingested_to", "String") +
            ", 3, 'UTC')",
        );
      }

      const sql = `
        SELECT
          event_id,
          event,
          schema_version,
          project_id,
          environment,
          formatDateTime(occurred_at, '%Y-%m-%dT%H:%i:%S.%fZ') AS occurred_at,
          formatDateTime(ingested_at, '%Y-%m-%dT%H:%i:%S.%fZ') AS ingested_at,
          formatDateTime(_consumed_at, '%Y-%m-%dT%H:%i:%S.%fZ') AS _consumed_at,
          _topic,
          _partition,
          toString(_offset) AS _offset
        FROM polaris.analytics_ingest_log
        WHERE ${where.join("\n          AND ")}
        ORDER BY ingested_at DESC, event_id ASC
        LIMIT ${bindScalar("limit", "UInt32")}
      `.trim();

      // Defense in depth: the ingest-log reader must never use FINAL.
      assertNoFinal(sql, "ingestLog.inspect");

      return runQuery<AnalyticsIngestLogRow>({
        underlying,
        query: sql,
        parameters: params,
      });
    },

    async trace(filter) {
      const limit = filter.limit ?? INGEST_LOG_TRACE_MAX_LIMIT;
      if (!Number.isInteger(limit) || limit <= 0 || limit > INGEST_LOG_TRACE_MAX_LIMIT) {
        throw new Error(
          `ingestLog.trace: limit must be an integer in [1, ${INGEST_LOG_TRACE_MAX_LIMIT}].`,
        );
      }

      const params: Record<string, unknown> = {
        event_id: filter.eventId,
        project_id: filter.projectId,
        limit,
      };
      const where: string[] = [
        "event_id = " + bindScalar("event_id", "String"),
        "project_id = " + bindScalar("project_id", "String"),
      ];
      if (filter.environment !== undefined) {
        params["environment"] = filter.environment;
        where.push("environment = " + bindScalar("environment", "String"));
      }

      const sql = `
        SELECT
          event_id,
          event,
          schema_version,
          project_id,
          environment,
          formatDateTime(occurred_at, '%Y-%m-%dT%H:%i:%S.%fZ') AS occurred_at,
          formatDateTime(ingested_at, '%Y-%m-%dT%H:%i:%S.%fZ') AS ingested_at,
          formatDateTime(_consumed_at, '%Y-%m-%dT%H:%i:%S.%fZ') AS _consumed_at,
          processor_name,
          processor_version,
          _topic,
          _partition,
          toString(_offset) AS _offset
        FROM polaris.analytics_ingest_log
        WHERE ${where.join("\n          AND ")}
        ORDER BY ingested_at ASC, _offset ASC
        LIMIT ${bindScalar("limit", "UInt32")}
      `.trim();

      // Defense in depth: the ingest-log reader must never use FINAL.
      // The table is append-only and its duplicates are the diagnostic.
      assertNoFinal(sql, "ingestLog.trace");

      return runQuery<IngestLogTraceRow>({
        underlying,
        query: sql,
        parameters: params,
      });
    },
  };
}

/**
 * Internal: build the SQL without executing. Exposed for the unit tests so
 * they can pin the generated shape.
 */
export function buildIngestLogInspectSql(filter: IngestLogFilter): string {
  // Mirrors `inspect` above without running it. Used by unit tests.
  const limit = filter.limit ?? 100;
  const where: string[] = ["project_id = " + bindScalar("project_id", "String")];
  if (filter.environment !== undefined) {
    where.push("environment = " + bindScalar("environment", "String"));
  }
  if (filter.event !== undefined) {
    where.push("event = " + bindScalar("event", "String"));
  }
  if (filter.eventId !== undefined) {
    where.push("event_id = " + bindScalar("event_id", "String"));
  }
  if (filter.ingestedFrom !== undefined) {
    where.push(
      "ingested_at >= parseDateTime64BestEffort(" +
        bindScalar("ingested_from", "String") +
        ", 3, 'UTC')",
    );
  }
  if (filter.ingestedTo !== undefined) {
    where.push(
      "ingested_at < parseDateTime64BestEffort(" +
        bindScalar("ingested_to", "String") +
        ", 3, 'UTC')",
    );
  }
  void limit;
  const sql = `
    SELECT
      event_id,
      event,
      schema_version,
      project_id,
      environment,
      formatDateTime(occurred_at, '%Y-%m-%dT%H:%i:%S.%fZ') AS occurred_at,
      formatDateTime(ingested_at, '%Y-%m-%dT%H:%i:%S.%fZ') AS ingested_at,
      formatDateTime(_consumed_at, '%Y-%m-%dT%H:%i:%S.%fZ') AS _consumed_at,
      _topic,
      _partition,
      toString(_offset) AS _offset
    FROM polaris.analytics_ingest_log
    WHERE ${where.join("\n      AND ")}
    ORDER BY ingested_at DESC, event_id ASC
    LIMIT ${bindScalar("limit", "UInt32")}
  `.trim();
  return assertNoFinal(sql, "ingestLog.inspect");
}
