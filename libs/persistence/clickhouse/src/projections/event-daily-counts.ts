/**
 * Typed reader for `polaris.event_daily_counts`.
 *
 * Backing DDL: `db/clickhouse/projections/40_event_daily_counts.sql`.
 * Feeder MV:   `db/clickhouse/materialized-views/41_mv_raw_to_event_daily_counts.sql`.
 *
 * The MV already deduped `analytics_raw` via `argMax(_, _version)` and the
 * projection table is a SummingMergeTree, so reads use plain `SELECT` with
 * an outer `sum()` defensive idiom (per
 * `docs/architecture/07-clickhouse.md` "Query Patterns / Pattern 2").
 *
 * No `FINAL` keyword anywhere — that is the project-wide rule for projection
 * reads.
 */

import type { ClickHouseClient as UnderlyingClickHouseClient } from "@clickhouse/client";
import { runQuery } from "../internal/exec.js";
import { assertNoFinal, bindScalar } from "../internal/sql.js";
import type { EventDailyCountRow, EventDailyCountsFilter } from "../types.js";

export interface EventDailyCountsReader {
  read(filter: EventDailyCountsFilter): Promise<EventDailyCountRow[]>;
}

export function createEventDailyCountsReader(input: {
  underlying: UnderlyingClickHouseClient;
}): EventDailyCountsReader {
  const { underlying } = input;

  return {
    async read(filter) {
      const limit = filter.limit ?? 1000;
      if (!Number.isInteger(limit) || limit <= 0 || limit > 100_000) {
        throw new Error("projections.eventDailyCounts.read: limit must be in [1, 100000].");
      }

      const sql = buildEventDailyCountsSql(filter);
      const params: Record<string, unknown> = {
        project_id: filter.projectId,
        from_date: filter.fromDate,
        limit,
      };
      if (filter.environment !== undefined) {
        params["environment"] = filter.environment;
      }
      if (filter.event !== undefined) {
        params["event"] = filter.event;
      }
      if (filter.toDate !== undefined) {
        params["to_date"] = filter.toDate;
      }

      return runQuery<EventDailyCountRow>({
        underlying,
        query: sql,
        parameters: params,
      });
    },
  };
}

/**
 * Build the read SQL for `event_daily_counts`. Exposed for unit-test
 * assertions on the generated SQL shape (no `FINAL`, has the expected
 * SummingMergeTree-safe `sum()` aggregation).
 */
export function buildEventDailyCountsSql(filter: EventDailyCountsFilter): string {
  const where: string[] = [
    "project_id = " + bindScalar("project_id", "String"),
    "occurred_date >= " + bindScalar("from_date", "Date"),
  ];
  if (filter.environment !== undefined) {
    where.push("environment = " + bindScalar("environment", "String"));
  }
  if (filter.event !== undefined) {
    where.push("event = " + bindScalar("event", "String"));
  }
  if (filter.toDate !== undefined) {
    where.push("occurred_date < " + bindScalar("to_date", "Date"));
  }

  const sql = `
    SELECT
      project_id,
      environment,
      event,
      toString(occurred_date) AS occurred_date,
      toString(sum(event_count)) AS event_count
    FROM polaris.event_daily_counts
    WHERE ${where.join("\n      AND ")}
    GROUP BY project_id, environment, event, occurred_date
    ORDER BY occurred_date ASC, event ASC
    LIMIT ${bindScalar("limit", "UInt32")}
  `.trim();

  return assertNoFinal(sql, "projections.eventDailyCounts.read");
}
