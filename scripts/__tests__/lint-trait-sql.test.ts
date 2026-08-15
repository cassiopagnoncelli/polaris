/**
 * `scripts/lint-trait-sql.mjs`.
 *
 * Two properties, and the false-positive half matters as much as the other.
 * The first version of this check flagged the shipped example for reading a
 * table called `the`, matched out of the prose "fed from `analytics_raw` by
 * a materialized view" — a doc comment explaining which source a trait reads
 * is exactly what good documentation looks like, and a check that punishes
 * it gets switched off.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { findTraitSqlProblems, stripComments, tablesReferenced, walk } from "../lint-trait-sql.mjs";

describe("findTraitSqlProblems", () => {
  it("accepts a definition reading an allowed projection", () => {
    const src = "const t = { sql: `SELECT profile_id FROM polaris.event_daily_counts` };";
    expect(findTraitSqlProblems(src, "t.ts")).toEqual([]);
  });

  it("rejects a definition reading analytics_raw, and explains why", () => {
    // The failure this exists to prevent: a full scan over the widest table
    // in the warehouse, on a cron, at 03:00, by a service-role client.
    const src = "const t = { sql: `SELECT profile_id FROM polaris.analytics_raw` };";
    const problems = findTraitSqlProblems(src, "t.ts");
    expect(problems).toHaveLength(1);
    expect(problems[0]?.table).toBe("analytics_raw");
    expect(problems[0]?.reason).toMatch(/add a projection/);
  });

  it("rejects a projection nobody allowed", () => {
    // An allowlist rather than "anything but analytics_raw": adding a
    // readable table should be a decision, not a name someone typed.
    const src = "const t = { sql: `SELECT x FROM polaris.some_new_table` };";
    expect(findTraitSqlProblems(src, "t.ts")).toHaveLength(1);
  });

  it("does not flag a forbidden table NAMED IN PROSE", () => {
    // The regression that shipped in the first draft.
    const src = [
      "/**",
      " * Reads event_daily_counts, which is fed from analytics_raw by a",
      " * materialized view — so the trait sees producer-reported orders.",
      " */",
      "const t = { sql: `SELECT profile_id FROM polaris.event_daily_counts` };",
    ].join("\n");
    expect(findTraitSqlProblems(src, "t.ts")).toEqual([]);
  });

  it("does not flag a line comment either", () => {
    const src =
      "// never read analytics_processed here\nconst t = { sql: `FROM event_daily_counts` };";
    expect(findTraitSqlProblems(src, "t.ts")).toEqual([]);
  });

  it("finds tables behind a JOIN as well as a FROM", () => {
    // A trait that joined its way to raw data would otherwise pass.
    const src = "const t = { sql: `FROM event_daily_counts JOIN analytics_raw USING (x)` };";
    const tables = tablesReferenced(stripComments(src));
    expect(tables).toContain("analytics_raw");
  });

  it("is case-insensitive and prefix-agnostic", () => {
    const src = "const t = { sql: `select x FROM POLARIS.ANALYTICS_RAW` };";
    expect(findTraitSqlProblems(src, "t.ts")).toHaveLength(1);
  });
});

describe("walk", () => {
  it("does not descend into node_modules", () => {
    // The catalog is a workspace package. Once pnpm links its dependencies
    // it has its own `node_modules`, and walking it made this check report
    // that zod's `union.test.ts` reads a projection called `both`.
    const root = mkdtempSync(join(tmpdir(), "trait-sql-"));
    mkdirSync(join(root, "node_modules", "zod"), { recursive: true });
    writeFileSync(join(root, "node_modules", "zod", "union.test.ts"), "from analytics_raw");
    writeFileSync(join(root, "orders-30d.ts"), "from event_daily_counts");

    expect(walk(root).map((file: string) => file.slice(root.length + 1))).toEqual([
      "orders-30d.ts",
    ]);
  });

  it("skips dist, so a built copy is not linted twice", () => {
    const root = mkdtempSync(join(tmpdir(), "trait-sql-"));
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "orders-30d.ts"), "from analytics_raw");

    expect(walk(root)).toEqual([]);
  });
});
