/**
 * Typed reader for `polaris.session_daily_metrics`.
 *
 * Backing DDL: `sql/clickhouse/projections/42_session_daily_metrics.sql`.
 * Feeder MV:   `sql/clickhouse/materialized-views/43_mv_processed_to_session_daily_metrics.sql`.
 *
 * The MV already deduped `analytics_processed` via `argMax(_, _version)`
 * and the projection table is a SummingMergeTree, so reads use plain
 * `SELECT` with an outer `sum()` defensive idiom (per
 * `docs/architecture/07-clickhouse.md` "Query Patterns / Pattern 2").
 *
 * Unlike `event_daily_counts`, there is no `event` filter: the event name
 * is already encoded by which counter a row contributes to.
 *
 * No `FINAL` keyword anywhere — that is the project-wide rule for
 * projection reads.
 */

import type { ClickHouseClient as UnderlyingClickHouseClient } from "@clickhouse/client";
import { runQuery } from "../internal/exec.js";
import { assertNoFinal, bindScalar } from "../internal/sql.js";
import type { SessionDailyMetricRow, SessionDailyMetricsFilter } from "../types.js";

export interface SessionDailyMetricsReader {
  read(filter: SessionDailyMetricsFilter): Promise<SessionDailyMetricRow[]>;
}

export function createSessionDailyMetricsReader(input: {
  underlying: UnderlyingClickHouseClient;
}): SessionDailyMetricsReader {
  const { underlying } = input;

  return {
    async read(filter) {
      const limit = filter.limit ?? 1000;
      if (!Number.isInteger(limit) || limit <= 0 || limit > 100_000) {
        throw new Error("projections.sessionDailyMetrics.read: limit must be in [1, 100000].");
      }

      const params: Record<string, unknown> = {
        project_id: filter.projectId,
        from_date: filter.fromDate,
        limit,
      };
      if (filter.environment !== undefined) {
        params["environment"] = filter.environment;
      }
      if (filter.toDate !== undefined) {
        params["to_date"] = filter.toDate;
      }

      return runQuery<SessionDailyMetricRow>({
        underlying,
        query: buildSessionDailyMetricsSql(filter),
        parameters: params,
      });
    },
  };
}

/**
 * Build the read SQL for `session_daily_metrics`. Exposed for unit-test
 * assertions on the generated SQL shape (no `FINAL`, SummingMergeTree-safe
 * `sum()` aggregation).
 */
export function buildSessionDailyMetricsSql(filter: SessionDailyMetricsFilter): string {
  const where: string[] = [
    "project_id = " + bindScalar("project_id", "String"),
    "occurred_date >= " + bindScalar("from_date", "Date"),
  ];
  if (filter.environment !== undefined) {
    where.push("environment = " + bindScalar("environment", "String"));
  }
  if (filter.toDate !== undefined) {
    where.push("occurred_date < " + bindScalar("to_date", "Date"));
  }

  const sql = `
    SELECT
      project_id,
      environment,
      toString(occurred_date) AS occurred_date,
      toString(sum(sessions_started)) AS sessions_started,
      toString(sum(sessions_ended)) AS sessions_ended
    FROM polaris.session_daily_metrics
    WHERE ${where.join("\n      AND ")}
    GROUP BY project_id, environment, occurred_date
    ORDER BY occurred_date ASC
    LIMIT ${bindScalar("limit", "UInt32")}
  `.trim();

  return assertNoFinal(sql, "projections.sessionDailyMetrics.read");
}
