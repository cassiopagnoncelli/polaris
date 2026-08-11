import { describe, expect, it } from "vitest";
import {
  buildArgMaxByEventKeySql,
  buildArgMaxProcessedByEventKeySql,
  buildCountDistinctEventsSql,
  buildCountDistinctProcessedEventsSql,
} from "../src/replay.js";

describe("buildArgMaxByEventKeySql", () => {
  const baseFilter = {
    projectId: "storefront",
    environment: "production",
    event: "checkout.completed",
    eventIds: ["a", "b", "c"],
  };

  it("generates SQL with argMax(<col>, _version) for each payload column", () => {
    const sql = buildArgMaxByEventKeySql(baseFilter);
    expect(sql).toMatch(/argMax\(occurred_at,\s*_version\)\s+AS\s+occurred_at/);
    expect(sql).toMatch(/argMax\(properties_json,\s*_version\)\s+AS\s+properties_json/);
    expect(sql).toMatch(/argMax\(processor_version,\s*_version\)\s+AS\s+processor_version/);
  });

  it("uses GROUP BY (project_id, environment, event, event_id)", () => {
    const sql = buildArgMaxByEventKeySql(baseFilter);
    expect(sql).toMatch(/GROUP BY \(project_id,\s*environment,\s*event,\s*event_id\)/);
  });

  it("does NOT contain the FINAL keyword", () => {
    const sql = buildArgMaxByEventKeySql(baseFilter);
    expect(sql).not.toMatch(/\bFINAL\b/i);
  });

  it("reads from polaris.analytics_raw", () => {
    const sql = buildArgMaxByEventKeySql(baseFilter);
    expect(sql).toMatch(/FROM\s+polaris\.analytics_raw/);
  });

  it("binds event_ids via Array(String) parameter", () => {
    const sql = buildArgMaxByEventKeySql(baseFilter);
    expect(sql).toMatch(/event_id\s+IN\s+\{event_ids:Array\(String\)\}/);
  });

  it("rejects an empty event-id list", () => {
    expect(() => buildArgMaxByEventKeySql({ ...baseFilter, eventIds: [] })).toThrow(/non-empty/i);
  });

  it("rejects oversized event-id lists", () => {
    const big = Array.from({ length: 5001 }, (_, i) => String(i));
    expect(() => buildArgMaxByEventKeySql({ ...baseFilter, eventIds: big })).toThrow(/5000/);
  });
});

describe("buildCountDistinctEventsSql", () => {
  const baseFilter = {
    projectId: "storefront",
    environment: "production",
    occurredFrom: "2026-05-01T00:00:00Z",
    occurredTo: "2026-05-02T00:00:00Z",
  };

  it("uses count(DISTINCT event_id)", () => {
    const sql = buildCountDistinctEventsSql(baseFilter);
    expect(sql).toMatch(/count\(DISTINCT\s+event_id\)/i);
  });

  it("does NOT contain the FINAL keyword", () => {
    const sql = buildCountDistinctEventsSql(baseFilter);
    expect(sql).not.toMatch(/\bFINAL\b/i);
  });

  it("reads from polaris.analytics_raw", () => {
    const sql = buildCountDistinctEventsSql(baseFilter);
    expect(sql).toMatch(/FROM\s+polaris\.analytics_raw/);
  });

  it("filters by an inclusive lower / exclusive upper occurred_at window", () => {
    const sql = buildCountDistinctEventsSql(baseFilter);
    expect(sql).toMatch(/occurred_at >=/);
    expect(sql).toMatch(/occurred_at </);
  });

  it("optionally narrows by event", () => {
    const sql = buildCountDistinctEventsSql({
      ...baseFilter,
      event: "checkout.completed",
    });
    expect(sql).toMatch(/event = \{event:String\}/);
  });
});

describe("analytics_processed readers", () => {
  const argMaxFilter = {
    projectId: "storefront",
    environment: "production",
    event: "session.started",
    eventIds: ["a", "b"],
  };
  const countFilter = {
    projectId: "storefront",
    environment: "production",
    occurredFrom: "2026-05-01T00:00:00Z",
    occurredTo: "2026-05-02T00:00:00Z",
  };

  it("reads from polaris.analytics_processed, not analytics_raw", () => {
    expect(buildArgMaxProcessedByEventKeySql(argMaxFilter)).toMatch(
      /FROM\s+polaris\.analytics_processed/,
    );
    expect(buildCountDistinctProcessedEventsSql(countFilter)).toMatch(
      /FROM\s+polaris\.analytics_processed/,
    );
    expect(buildArgMaxProcessedByEventKeySql(argMaxFilter)).not.toMatch(/analytics_raw/);
  });

  it("applies the same dedupe pattern and never uses FINAL", () => {
    const sql = buildArgMaxProcessedByEventKeySql(argMaxFilter);
    expect(sql).toMatch(/GROUP BY \(project_id,\s*environment,\s*event,\s*event_id\)/);
    expect(sql).toMatch(/argMax\(properties_json,\s*_version\)\s+AS\s+properties_json/);
    expect(sql).not.toMatch(/\bFINAL\b/i);
  });

  it("projects the transport lineage columns", () => {
    // The derived path has no ingest log, so the lineage on the surviving
    // row is the only record of which offset produced it.
    const sql = buildArgMaxProcessedByEventKeySql(argMaxFilter);
    expect(sql).toMatch(/argMax\(_topic,\s*_version\)\s+AS\s+_topic/);
    expect(sql).toMatch(/argMax\(_offset,\s*_version\)\s+AS\s+_offset/);
  });

  it("omits columns that are structurally absent on derived envelopes", () => {
    // Processors strip the source IP and never emit through an SDK.
    const sql = buildArgMaxProcessedByEventKeySql(argMaxFilter);
    for (const column of ["ip", "user_agent", "locale", "sdk", "sdk_version"]) {
      expect(sql).not.toMatch(new RegExp(`argMax\\(${column},`));
    }
  });

  it("keeps the same bounds on the event-id list", () => {
    expect(() => buildArgMaxProcessedByEventKeySql({ ...argMaxFilter, eventIds: [] })).toThrow(
      /non-empty/i,
    );
    const big = Array.from({ length: 5001 }, (_, i) => String(i));
    expect(() => buildArgMaxProcessedByEventKeySql({ ...argMaxFilter, eventIds: big })).toThrow(
      /5000/,
    );
  });

  it("names the calling method in its errors", () => {
    expect(() => buildArgMaxProcessedByEventKeySql({ ...argMaxFilter, eventIds: [] })).toThrow(
      /argMaxProcessedByEventKey/,
    );
  });
});
