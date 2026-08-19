/**
 * Enablement, and the two defaults that decide whether it is safe.
 *
 * §6 puts reverse-ETL enablement in `project_config`, and it was not
 * there: a job ran for whichever project the crontab named, and turning it
 * off for one customer meant editing a crontab on a host.
 *
 * The whole design is in two default choices, which is why they are what
 * this suite asserts:
 *
 *   absent  → no restriction. The opposite reads safer and is worse:
 *             shipping the key would silently stop every existing crontab
 *             entry, and a writeback that stops WITHOUT failing is the
 *             exact outcome the command's non-zero-exit rule exists to
 *             prevent.
 *   []      → nothing. The deliberate way to say "none", distinguishable
 *             from never having been set.
 *
 * And one failure choice: a slice that does not parse is NOT enabled. On
 * this path the safe failure is to skip and say why, because a malformed
 * value is most likely an operator part-way through turning something off.
 */

import { describe, expect, it } from "vitest";

import { jobEnabled } from "../src/enablement.js";
import { projectConfigSchema } from "../src/project-config.js";

describe("jobEnabled", () => {
  it("allows any job when the key was never set", () => {
    expect(jobEnabled("ltv_writeback", {})).toEqual({ enabled: true });
  });

  it("ignores other keys in the same slice", () => {
    // `reverse_etl` also holds `ingest_api_key`. A schema that rejected it
    // would disable every project that has ever run a job — which is every
    // project that has one configured at all.
    expect(jobEnabled("ltv_writeback", { ingest_api_key: "***" })).toEqual({ enabled: true });
  });

  it("allows a job that is listed", () => {
    expect(jobEnabled("ltv_writeback", { enabled_jobs: ["ltv_writeback"] })).toEqual({
      enabled: true,
    });
  });

  it("refuses a job that is not listed, and names what is", () => {
    const verdict = jobEnabled("ltv_writeback", { enabled_jobs: ["something_else"] });
    expect(verdict.enabled).toBe(false);
    expect(verdict.reason).toContain("something_else");
  });

  it("treats an explicit empty list as 'none', not as 'unset'", () => {
    const verdict = jobEnabled("ltv_writeback", { enabled_jobs: [] });
    expect(verdict.enabled).toBe(false);
    expect(verdict.reason).toContain("empty");
  });

  it("refuses rather than allows when the value does not parse", () => {
    // The direction matters. Falling open here would mean a typo in the
    // key an operator was using to switch a job OFF leaves it running.
    for (const bad of [
      { enabled_jobs: "ltv_writeback" }, // a string, not a list
      { enabled_jobs: [42] },
      { enabled_jobs: ["Not A Key"] },
      { enabled_jobs: null },
    ]) {
      const verdict = jobEnabled("ltv_writeback", bad as Record<string, unknown>);
      expect(verdict.enabled, JSON.stringify(bad)).toBe(false);
      expect(verdict.reason).toBeDefined();
    }
  });
});

describe("the schema", () => {
  it("strips unknown keys rather than rejecting the slice", () => {
    const parsed = projectConfigSchema.safeParse({ ingest_api_key: "***", future_key: 1 });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({});
  });
});
