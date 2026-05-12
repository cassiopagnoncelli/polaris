import { describe, expect, it } from "vitest";
import { buildIngestLogInspectSql } from "../src/ingest-log.js";
import { buildEventDailyCountsSql } from "../src/projections/event-daily-counts.js";

describe("buildEventDailyCountsSql", () => {
  const baseFilter = {
    projectId: "storefront",
    fromDate: "2026-05-01",
  };

  it("does NOT contain the FINAL keyword", () => {
    const sql = buildEventDailyCountsSql(baseFilter);
    expect(sql).not.toMatch(/\bFINAL\b/i);
  });

  it("reads from polaris.event_daily_counts (NOT analytics_raw)", () => {
    const sql = buildEventDailyCountsSql(baseFilter);
    expect(sql).toMatch(/FROM\s+polaris\.event_daily_counts/);
    expect(sql).not.toMatch(/analytics_raw/);
  });

  it("uses defensive sum(event_count) idiom for SummingMergeTree", () => {
    const sql = buildEventDailyCountsSql(baseFilter);
    expect(sql).toMatch(/sum\(event_count\)/);
  });

  it("orders by occurred_date ASC", () => {
    const sql = buildEventDailyCountsSql(baseFilter);
    expect(sql).toMatch(/ORDER BY occurred_date ASC/);
  });

  it("optionally narrows by environment and event", () => {
    const sql = buildEventDailyCountsSql({
      ...baseFilter,
      environment: "production",
      event: "checkout.completed",
      toDate: "2026-06-01",
    });
    expect(sql).toMatch(/environment = \{environment:String\}/);
    expect(sql).toMatch(/event = \{event:String\}/);
    expect(sql).toMatch(/occurred_date < \{to_date:Date\}/);
  });
});

describe("buildIngestLogInspectSql", () => {
  const baseFilter = {
    projectId: "storefront",
  };

  it("does NOT contain the FINAL keyword", () => {
    const sql = buildIngestLogInspectSql(baseFilter);
    expect(sql).not.toMatch(/\bFINAL\b/i);
  });

  it("reads from polaris.analytics_ingest_log (NOT analytics_raw)", () => {
    const sql = buildIngestLogInspectSql(baseFilter);
    expect(sql).toMatch(/FROM\s+polaris\.analytics_ingest_log/);
    expect(sql).not.toMatch(/analytics_raw/);
  });

  it("supports filtering by event_id", () => {
    const sql = buildIngestLogInspectSql({
      ...baseFilter,
      eventId: "abc",
    });
    expect(sql).toMatch(/event_id = \{event_id:String\}/);
  });

  it("supports ingested_at time bounds", () => {
    const sql = buildIngestLogInspectSql({
      ...baseFilter,
      ingestedFrom: "2026-05-01T00:00:00Z",
      ingestedTo: "2026-05-02T00:00:00Z",
    });
    expect(sql).toMatch(/ingested_at >= parseDateTime64BestEffort/);
    expect(sql).toMatch(/ingested_at < parseDateTime64BestEffort/);
  });
});
