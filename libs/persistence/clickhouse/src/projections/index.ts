/**
 * Projection-table readers.
 *
 * Each projection table in `db/clickhouse/projections/` has a typed reader
 * here. Adding a new projection is a four-step process:
 *
 *   1. Land the DDL in `db/clickhouse/projections/<name>.sql`.
 *   2. Land the argMax-based MV in `db/clickhouse/materialized-views/`.
 *   3. Add the SELECT grant to `db/clickhouse/roles/01_grants.sql`.
 *   4. Add a reader module here and re-export from this index.
 *
 * Projection reads use plain `SELECT` because the MV upstream already
 * deduped via `argMax(_, _version)`. They MUST NOT use `FINAL`.
 */

import type { ClickHouseClient as UnderlyingClickHouseClient } from "@clickhouse/client";
import { createEventDailyCountsReader, type EventDailyCountsReader } from "./event-daily-counts.js";
import {
  createSessionDailyMetricsReader,
  type SessionDailyMetricsReader,
} from "./session-daily-metrics.js";

export interface ProjectionReaders {
  readonly eventDailyCounts: EventDailyCountsReader;
  /** Fed from `analytics_processed`, not `analytics_raw`. */
  readonly sessionDailyMetrics: SessionDailyMetricsReader;
}

export function createProjectionReaders(input: {
  underlying: UnderlyingClickHouseClient;
}): ProjectionReaders {
  return {
    eventDailyCounts: createEventDailyCountsReader({ underlying: input.underlying }),
    sessionDailyMetrics: createSessionDailyMetricsReader({ underlying: input.underlying }),
  };
}

export type { EventDailyCountsReader } from "./event-daily-counts.js";
export type { SessionDailyMetricsReader } from "./session-daily-metrics.js";
