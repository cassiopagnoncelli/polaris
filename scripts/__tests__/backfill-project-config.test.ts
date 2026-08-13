/**
 * The backfill's pure planning core.
 *
 * The database half is exercised by hand against a real Postgres before each
 * cutover; what is worth pinning here is the parsing, because it reads
 * hand-maintained strings where a typo is likelier than in generated input and
 * a silently-wrong number is worse than no number at all.
 */

import { describe, expect, it } from "vitest";
import { parseProjectPairs, planBackfill } from "../backfill-project-config.mjs";

describe("parseProjectPairs", () => {
  it("expands a comma-separated string to one entry per project", () => {
    expect(parseProjectPairs("checkout=3600, marketing=86400")).toEqual({
      entries: [
        { projectId: "checkout", value: 3600 },
        { projectId: "marketing", value: 86_400 },
      ],
      problems: [],
    });
  });

  it("treats an empty or whitespace string as nothing to do", () => {
    expect(parseProjectPairs("")).toEqual({ entries: [], problems: [] });
    expect(parseProjectPairs("   ")).toEqual({ entries: [], problems: [] });
    expect(parseProjectPairs(undefined)).toEqual({ entries: [], problems: [] });
  });

  it("reports a malformed pair and keeps the good ones", () => {
    // Skipped, never guessed: seeding a wrong number silently is worse than
    // seeding nothing and saying so.
    const result = parseProjectPairs("checkout=3600,broken,marketing=900");
    expect(result.entries).toEqual([
      { projectId: "checkout", value: 3600 },
      { projectId: "marketing", value: 900 },
    ]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("broken");
  });

  it("rejects non-integer and non-positive values", () => {
    const result = parseProjectPairs("a=abc,b=0,c=-5,d=1.5");
    expect(result.entries).toEqual([]);
    expect(result.problems).toHaveLength(4);
  });
});

describe("planBackfill", () => {
  it("maps both retired ingester variables onto their config keys", () => {
    const { rows, problems } = planBackfill("ingester-api", {
      POLARIS_INGEST_PROJECT_DEDUPE_WINDOWS: "checkout=3600",
      POLARIS_RATE_LIMIT_PROJECT_OVERRIDES: "checkout=5000,marketing=200",
    });
    expect(problems).toEqual([]);
    expect(rows).toEqual([
      {
        projectId: "checkout",
        namespace: "ingest",
        configKey: "dedupe_window_sec",
        value: 3600,
        source: "POLARIS_INGEST_PROJECT_DEDUPE_WINDOWS",
      },
      {
        projectId: "checkout",
        namespace: "ingest",
        configKey: "rate_limit_rps",
        value: 5000,
        source: "POLARIS_RATE_LIMIT_PROJECT_OVERRIDES",
      },
      {
        projectId: "marketing",
        namespace: "ingest",
        configKey: "rate_limit_rps",
        value: 200,
        source: "POLARIS_RATE_LIMIT_PROJECT_OVERRIDES",
      },
    ]);
  });

  it("plans nothing when the retired variables are unset", () => {
    // The expected state AFTER the cutover deletes them from the manifest —
    // a re-run must be a no-op, not an error.
    expect(planBackfill("ingester-api", {})).toEqual({ rows: [], problems: [] });
  });

  it("carries the source variable so the audit reason names where a value came from", () => {
    const { rows } = planBackfill("ingester-api", {
      POLARIS_INGEST_PROJECT_DEDUPE_WINDOWS: "checkout=3600",
    });
    expect(rows[0]?.source).toBe("POLARIS_INGEST_PROJECT_DEDUPE_WINDOWS");
  });

  it("refuses an unknown service by name, listing the known ones", () => {
    expect(() => planBackfill("sessionizer", {})).toThrow(/unknown service "sessionizer"/);
    expect(() => planBackfill("sessionizer", {})).toThrow(/ingester-api/);
  });
});
