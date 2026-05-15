/**
 * Unit tests for the ClickHouse health-probe SQL builders.
 *
 * The probes target `system.*` views and feed the analytics-projector's
 * proxy-via-canonical-consumer metrics surface (P12 ClickHouse alerts /
 * dashboard backfill). They MUST:
 *
 *   - never use FINAL (the project-wide rule),
 *   - bind every variable through ClickHouse `{name:Type}` params,
 *   - shape the result so the gauge labels read straight from row fields.
 */

import { describe, expect, it } from "vitest";
import {
  buildKafkaIngestionLagSql,
  buildMaterializedViewStatesSql,
  buildPartsSummarySql,
} from "../src/probes/index.js";

describe("buildPartsSummarySql", () => {
  it("does NOT contain the FINAL keyword", () => {
    expect(buildPartsSummarySql()).not.toMatch(/\bFINAL\b/i);
  });

  it("reads from system.parts (NOT a Kafka-Engine or analytics_raw table)", () => {
    const sql = buildPartsSummarySql();
    expect(sql).toMatch(/FROM\s+system\.parts/);
    expect(sql).not.toMatch(/analytics_raw|analytics_events_queue/);
  });

  it("filters to active parts only and groups by (database, table)", () => {
    const sql = buildPartsSummarySql();
    expect(sql).toMatch(/active\s*=\s*1/);
    expect(sql).toMatch(/GROUP BY database, table/);
  });

  it("binds database and limit through query parameters", () => {
    const sql = buildPartsSummarySql();
    expect(sql).toMatch(/\{database:String\}/);
    expect(sql).toMatch(/\{limit:UInt32\}/);
  });
});

describe("buildMaterializedViewStatesSql", () => {
  it("does NOT contain the FINAL keyword", () => {
    expect(buildMaterializedViewStatesSql()).not.toMatch(/\bFINAL\b/i);
  });

  it("reads from system.view_refreshes (the v1 MV-state ledger)", () => {
    const sql = buildMaterializedViewStatesSql();
    expect(sql).toMatch(/FROM\s+system\.view_refreshes/);
  });

  it("aliases the row fields the analytics-projector needs as gauge labels", () => {
    // The processor emits polaris_clickhouse_mv_state{view,state}; the SQL
    // must produce `view`, `state`, and `last_exception` columns so the
    // processor wiring stays a 1:1 read.
    const sql = buildMaterializedViewStatesSql();
    expect(sql).toMatch(/AS\s+view/);
    expect(sql).toMatch(/AS\s+state/);
    expect(sql).toMatch(/last_exception/);
  });

  it("binds database and limit through query parameters", () => {
    const sql = buildMaterializedViewStatesSql();
    expect(sql).toMatch(/\{database:String\}/);
    expect(sql).toMatch(/\{limit:UInt32\}/);
  });
});

describe("buildKafkaIngestionLagSql", () => {
  it("does NOT contain the FINAL keyword", () => {
    expect(buildKafkaIngestionLagSql()).not.toMatch(/\bFINAL\b/i);
  });

  it("reads from system.kafka_consumers (NOT the Kafka-Engine table)", () => {
    const sql = buildKafkaIngestionLagSql();
    expect(sql).toMatch(/FROM\s+system\.kafka_consumers/);
    expect(sql).not.toMatch(/analytics_events_queue/);
  });

  it("computes max lag in seconds per (database, table) using dateDiff", () => {
    const sql = buildKafkaIngestionLagSql();
    expect(sql).toMatch(/dateDiff\('second',\s*last_poll_time,\s*now\(\)\)/);
    expect(sql).toMatch(/AS\s+lag_seconds/);
    expect(sql).toMatch(/GROUP BY database, table/);
  });

  it("filters to currently-used consumers so cold-start never trips the page alert", () => {
    const sql = buildKafkaIngestionLagSql();
    expect(sql).toMatch(/is_currently_used\s*=\s*1/);
  });

  it("binds database and limit through query parameters", () => {
    const sql = buildKafkaIngestionLagSql();
    expect(sql).toMatch(/\{database:String\}/);
    expect(sql).toMatch(/\{limit:UInt32\}/);
  });
});
