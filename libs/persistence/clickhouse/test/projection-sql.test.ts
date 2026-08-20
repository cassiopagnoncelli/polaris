import { describe, expect, it } from "vitest";
import { buildIngestLogInspectSql, createIngestLogReader } from "../src/ingest-log.js";
import { buildEventDailyCountsSql } from "../src/projections/event-daily-counts.js";
import { buildSessionDailyMetricsSql } from "../src/projections/session-daily-metrics.js";

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

describe("buildSessionDailyMetricsSql", () => {
  const baseFilter = {
    projectId: "storefront",
    fromDate: "2026-05-01",
  };

  it("does NOT contain the FINAL keyword", () => {
    expect(buildSessionDailyMetricsSql(baseFilter)).not.toMatch(/\bFINAL\b/i);
  });

  it("reads the projection, not the raw-tier table behind it", () => {
    const sql = buildSessionDailyMetricsSql(baseFilter);
    expect(sql).toMatch(/FROM\s+polaris\.session_daily_metrics/);
    expect(sql).not.toMatch(/analytics_processed/);
    expect(sql).not.toMatch(/analytics_raw/);
  });

  it("uses the defensive sum() idiom on both counters", () => {
    const sql = buildSessionDailyMetricsSql(baseFilter);
    expect(sql).toMatch(/sum\(sessions_started\)/);
    expect(sql).toMatch(/sum\(sessions_ended\)/);
  });

  it("groups without the event column", () => {
    // The event name is encoded by which counter a row feeds, so keying
    // on it would split each day into two rows that always sum back
    // together.
    const sql = buildSessionDailyMetricsSql(baseFilter);
    expect(sql).toMatch(/GROUP BY project_id, environment, occurred_date/);
    expect(sql).not.toMatch(/\bevent\b\s*=/);
  });

  it("optionally narrows by environment and upper date bound", () => {
    const sql = buildSessionDailyMetricsSql({
      ...baseFilter,
      environment: "production",
      toDate: "2026-06-01",
    });
    expect(sql).toMatch(/environment = \{environment:String\}/);
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

/**
 * The trace SQL is asserted through the reader rather than through a
 * test-only builder: the fake client captures the query that would
 * actually be issued, so the test cannot drift from the real path the way
 * a parallel `build*Sql` helper can.
 */
function captureTraceSql(filter: Parameters<ReturnType<typeof createIngestLogReader>["trace"]>[0]) {
  let captured = "";
  const underlying = {
    query: async (input: { query: string }) => {
      captured = input.query;
      return { json: async () => [] };
    },
  } as unknown as Parameters<typeof createIngestLogReader>[0]["underlying"];
  const reader = createIngestLogReader({ underlying });
  return reader.trace(filter).then(() => captured);
}

describe("ingestLog.trace SQL", () => {
  const baseFilter = {
    eventId: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
    projectId: "storefront",
  };

  it("does NOT contain the FINAL keyword", async () => {
    // The ingest log is the append-only transport record. FINAL would
    // collapse the duplicate rows that are the whole diagnostic point.
    expect(await captureTraceSql(baseFilter)).not.toMatch(/\bFINAL\b/i);
  });

  it("reads from polaris.analytics_ingest_log (NOT analytics_raw)", async () => {
    const sql = await captureTraceSql(baseFilter);
    expect(sql).toMatch(/FROM\s+polaris\.analytics_ingest_log/);
    expect(sql).not.toMatch(/analytics_raw/);
  });

  it("binds both event_id and project_id", async () => {
    // project_id is not optional: it leads the table's ORDER BY, so
    // dropping it turns a key lookup into a scan of the whole window.
    const sql = await captureTraceSql(baseFilter);
    expect(sql).toMatch(/event_id = \{event_id:String\}/);
    expect(sql).toMatch(/project_id = \{project_id:String\}/);
  });

  it("selects the processor stamp columns", async () => {
    const sql = await captureTraceSql(baseFilter);
    expect(sql).toMatch(/processor_name/);
    expect(sql).toMatch(/processor_version/);
  });

  it("selects the transport lineage columns", async () => {
    const sql = await captureTraceSql(baseFilter);
    expect(sql).toMatch(/_topic/);
    expect(sql).toMatch(/_partition/);
    expect(sql).toMatch(/toString\(_offset\)/);
  });

  it("orders oldest first so the output reads as a timeline", async () => {
    const sql = await captureTraceSql(baseFilter);
    expect(sql).toMatch(/ORDER BY ingested_at ASC, _offset ASC/);
  });

  it("never selects the event payload", async () => {
    // A trace reports lineage, not content. `properties` is where the
    // event's data lives and it must not appear in the projection.
    const sql = await captureTraceSql(baseFilter);
    expect(sql).not.toMatch(/\bproperties\b/);
    expect(sql).not.toMatch(/\bidentity\b/);
    expect(sql).not.toMatch(/\bcontext\b/);
  });

  it("narrows by environment when one is given", async () => {
    const sql = await captureTraceSql({ ...baseFilter, environment: "production" });
    expect(sql).toMatch(/environment = \{environment:String\}/);
  });

  it("refuses a limit past the hard cap", async () => {
    await expect(captureTraceSql({ ...baseFilter, limit: 10_000 })).rejects.toThrow(/limit/);
  });
});
