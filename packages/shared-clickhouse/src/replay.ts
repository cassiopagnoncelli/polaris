/**
 * Operator-only typed readers against the two raw-tier tables,
 * `polaris.analytics_raw` and `polaris.analytics_processed`.
 *
 * Both are ReplacingMergeTree. Between merges, duplicate rows for the
 * same (project_id, environment, event, event_id) coexist — see
 * `docs/architecture/07-clickhouse.md` "Query Patterns". These readers
 * use the canonical `argMax(col, _version) GROUP BY (project_id,
 * environment, event, event_id)` pattern. They never use `FINAL`.
 *
 * The two tables share a sort key and therefore share every query shape;
 * only the projected column list differs. One set of builders takes the
 * table and its columns so the dedupe pattern is implemented once —
 * a second hand-written copy is exactly how the two would drift.
 *
 * Service-profile clients do NOT receive this namespace; their database
 * role has no SELECT grant on either table. The two layers are
 * intentional defense in depth.
 */

import type { ClickHouseClient as UnderlyingClickHouseClient } from "@clickhouse/client";
import { runQuery } from "./internal/exec.js";
import { argMaxProjection, assertNoFinal, bindArray, bindScalar } from "./internal/sql.js";
import type {
  AnalyticsProcessedRow,
  AnalyticsRawRow,
  ArgMaxByEventKeyFilter,
  CountDistinctEventsFilter,
} from "./types.js";

export interface ReplayReader {
  /**
   * Read a bounded list of event IDs from `analytics_raw`, applying the
   * argMax dedupe pattern. Returns at most one row per `event_id`.
   *
   * `eventIds` must be a non-empty bounded list. Operators who need
   * open-ended scans must use `raw.query` so the call leaves an audit trail.
   */
  argMaxByEventKey(filter: ArgMaxByEventKeyFilter): Promise<AnalyticsRawRow[]>;
  /**
   * Count distinct `event_id`s for the given filter window. Equivalent to
   * `count(DISTINCT event_id) FROM analytics_raw`, which sidesteps the merge
   * state entirely (per `docs/architecture/07-clickhouse.md` "Pattern 4").
   */
  countDistinctEvents(filter: CountDistinctEventsFilter): Promise<number>;
  /**
   * `argMaxByEventKey` against `analytics_processed` — the derived facts
   * Polaris concluded (`enriched.geoip`, `session.started`,
   * `identity.linked`, `touchpoint_captured`, ...).
   *
   * `filter.event` is the derived event name, not the source event that
   * triggered it. To trace a source event to what was derived from it,
   * join on the identity columns rather than on `event_id`: a derived
   * event carries its own id.
   */
  argMaxProcessedByEventKey(filter: ArgMaxByEventKeyFilter): Promise<AnalyticsProcessedRow[]>;
  /** `countDistinctEvents` against `analytics_processed`. */
  countDistinctProcessedEvents(filter: CountDistinctEventsFilter): Promise<number>;
}

/**
 * Columns we project through the argMax pattern. Keep this list in sync
 * with `sql/clickhouse/30_analytics_raw.sql`. The ORDER BY columns
 * (`project_id`, `environment`, `event`, `event_id`) appear in the
 * GROUP BY, not the argMax projection, because they are constant within
 * each group.
 */
const ARG_MAX_COLUMNS = [
  "schema_version",
  "occurred_at",
  "ingested_at",
  "source_id",
  "source_type",
  "sdk",
  "sdk_version",
  "anonymous_id",
  "session_id",
  "customer_id",
  "device_id",
  "ip",
  "user_agent",
  "locale",
  "properties_json",
  "context_json",
  "consent_json",
  "privacy_json",
  "processor_name",
  "processor_version",
] as const;

/**
 * Columns projected through argMax for `analytics_processed`. Keep in
 * sync with `sql/clickhouse/32_analytics_processed.sql`.
 *
 * The lineage columns are projected too: the derived path has no ingest
 * log, so `_topic` / `_partition` / `_offset` on the surviving row are
 * the only record of which stream offset produced it.
 */
const PROCESSED_ARG_MAX_COLUMNS = [
  "schema_version",
  "occurred_at",
  "ingested_at",
  "source_id",
  "source_type",
  "anonymous_id",
  "session_id",
  "customer_id",
  "device_id",
  "properties_json",
  "context_json",
  "consent_json",
  "privacy_json",
  "processor_name",
  "processor_version",
  "_topic",
  "_partition",
  "_offset",
] as const;

const RAW_TABLE = "polaris.analytics_raw";
const PROCESSED_TABLE = "polaris.analytics_processed";

export function createReplayReader(input: {
  underlying: UnderlyingClickHouseClient;
}): ReplayReader {
  const { underlying } = input;

  return {
    async argMaxByEventKey(filter) {
      const sql = buildArgMaxByEventKeySql(filter);
      const params: Record<string, unknown> = {
        project_id: filter.projectId,
        environment: filter.environment,
        event: filter.event,
        event_ids: filter.eventIds,
      };

      // Decode the row so `_version` and `schema_version` come back as
      // numbers; ClickHouse JSON for UInt32 / UInt64 emits as a string when
      // values exceed 2^53. Keeping `_version` as `number | string` in the
      // type allows large monotonic versions without lossy coercion.
      return runQuery<AnalyticsRawRow>({
        underlying,
        query: sql,
        parameters: params,
      });
    },

    async countDistinctEvents(filter) {
      const sql = buildCountDistinctEventsSql(filter);
      const params: Record<string, unknown> = {
        project_id: filter.projectId,
        environment: filter.environment,
        occurred_from: filter.occurredFrom,
        occurred_to: filter.occurredTo,
      };
      if (filter.event !== undefined) {
        params["event"] = filter.event;
      }
      const rows = await runQuery<{ distinct: string | number }>({
        underlying,
        query: sql,
        parameters: params,
      });
      const first = rows[0];
      if (!first) {
        return 0;
      }
      const value = typeof first.distinct === "string" ? Number(first.distinct) : first.distinct;
      if (!Number.isFinite(value)) {
        return 0;
      }
      return value;
    },

    async argMaxProcessedByEventKey(filter) {
      return runQuery<AnalyticsProcessedRow>({
        underlying,
        query: buildArgMaxProcessedByEventKeySql(filter),
        parameters: {
          project_id: filter.projectId,
          environment: filter.environment,
          event: filter.event,
          event_ids: filter.eventIds,
        },
      });
    },

    async countDistinctProcessedEvents(filter) {
      const params: Record<string, unknown> = {
        project_id: filter.projectId,
        environment: filter.environment,
        occurred_from: filter.occurredFrom,
        occurred_to: filter.occurredTo,
      };
      if (filter.event !== undefined) {
        params["event"] = filter.event;
      }
      const rows = await runQuery<{ distinct: string | number }>({
        underlying,
        query: buildCountDistinctProcessedEventsSql(filter),
        parameters: params,
      });
      const first = rows[0];
      if (!first) {
        return 0;
      }
      const value = typeof first.distinct === "string" ? Number(first.distinct) : first.distinct;
      return Number.isFinite(value) ? value : 0;
    },
  };
}

/**
 * Build the argMax SQL. Exposed for unit-test assertions that pin:
 * - presence of `argMax(<col>, _version)` for every payload column,
 * - presence of `GROUP BY (project_id, environment, event, event_id)`,
 * - absence of `FINAL`.
 */
export function buildArgMaxByEventKeySql(filter: ArgMaxByEventKeyFilter): string {
  return buildArgMaxSql(filter, {
    table: RAW_TABLE,
    columns: ARG_MAX_COLUMNS,
    caller: "replay.argMaxByEventKey",
  });
}

/**
 * `buildArgMaxByEventKeySql` for `analytics_processed`. Same guarantees,
 * asserted by the same tests: argMax per payload column, the four-column
 * GROUP BY, no `FINAL`.
 */
export function buildArgMaxProcessedByEventKeySql(filter: ArgMaxByEventKeyFilter): string {
  return buildArgMaxSql(filter, {
    table: PROCESSED_TABLE,
    columns: PROCESSED_ARG_MAX_COLUMNS,
    caller: "replay.argMaxProcessedByEventKey",
  });
}

function buildArgMaxSql(
  filter: ArgMaxByEventKeyFilter,
  target: { table: string; columns: readonly string[]; caller: string },
): string {
  if (filter.eventIds.length === 0) {
    throw new Error(
      `${target.caller}: eventIds must be a non-empty array. Open-ended scans must go through raw.query.`,
    );
  }
  if (filter.eventIds.length > 5000) {
    throw new Error(
      `${target.caller}: eventIds bounded to 5000 per call. Use raw.query for larger scans.`,
    );
  }

  const argMax = argMaxProjection([...target.columns]);

  const sql = `
    SELECT
        project_id,
        environment,
        event,
        event_id,
        ${argMax}
    FROM ${target.table}
    WHERE project_id = ${bindScalar("project_id", "String")}
      AND environment = ${bindScalar("environment", "String")}
      AND event = ${bindScalar("event", "String")}
      AND event_id IN ${bindArray("event_ids", "Array(String)")}
    GROUP BY (project_id, environment, event, event_id)
  `.trim();

  return assertNoFinal(sql, target.caller);
}

/**
 * Build the count-distinct SQL. Exposed for unit-test assertions on the
 * generated shape (no `FINAL`, uses `count(DISTINCT event_id)`).
 */
export function buildCountDistinctEventsSql(filter: CountDistinctEventsFilter): string {
  return buildCountDistinctSql(filter, RAW_TABLE, "replay.countDistinctEvents");
}

/** `buildCountDistinctEventsSql` for `analytics_processed`. */
export function buildCountDistinctProcessedEventsSql(filter: CountDistinctEventsFilter): string {
  return buildCountDistinctSql(filter, PROCESSED_TABLE, "replay.countDistinctProcessedEvents");
}

function buildCountDistinctSql(
  filter: CountDistinctEventsFilter,
  table: string,
  caller: string,
): string {
  const where: string[] = [
    "project_id = " + bindScalar("project_id", "String"),
    "environment = " + bindScalar("environment", "String"),
    "occurred_at >= parseDateTime64BestEffort(" +
      bindScalar("occurred_from", "String") +
      ", 3, 'UTC')",
    "occurred_at < parseDateTime64BestEffort(" +
      bindScalar("occurred_to", "String") +
      ", 3, 'UTC')",
  ];
  if (filter.event !== undefined) {
    where.push("event = " + bindScalar("event", "String"));
  }

  const sql = `
    SELECT toString(count(DISTINCT event_id)) AS distinct
    FROM ${table}
    WHERE ${where.join("\n      AND ")}
  `.trim();

  return assertNoFinal(sql, caller);
}
