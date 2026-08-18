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

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));

import {
  ALLOWED_TABLES,
  eventLiteralsReferenced,
  findTraitSqlProblems,
  registeredEventNames,
  SCANNED_CATALOG_DIRS,
  stripComments,
  tablesReferenced,
  walk,
} from "../lint-trait-sql.mjs";

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

describe("SCANNED_CATALOG_DIRS", () => {
  it("covers audiences as well as traits", () => {
    // Audiences arrived after this check did. A projection-sourced
    // audience is cron-driven SQL against the same shared cluster, so a
    // definition source outside the scan would be a hole in exactly the
    // shape this check exists to close.
    expect(SCANNED_CATALOG_DIRS).toContain("traits");
    expect(SCANNED_CATALOG_DIRS).toContain("audiences");
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

describe("the allowlist mirrors the catalog", () => {
  it("permits exactly the projections the catalog declares readable", () => {
    // Two copies of one list, and the lint's own comment says it mirrors
    // the catalog's. Adding `profile_event_daily_counts` updated the lint
    // and not the catalog, which would have let a trait pass the lint and
    // then be refused by the type it is parsed against.
    //
    // Read from the source rather than imported, because the catalog is a
    // workspace package and a lint that needed it built would be a lint
    // that fails on a fresh checkout.
    const source = readFileSync(
      resolve(__dirname, "..", "..", "catalog", "traits", "types.ts"),
      "utf8",
    );
    const block = /READABLE_PROJECTIONS = \[(.*?)\] as const;/s.exec(source)?.[1] ?? "";
    const declared = [...block.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);

    expect([...ALLOWED_TABLES].sort()).toEqual([...declared].sort());
  });
});

/**
 * Event names are a closed set, and only this check enforces it.
 *
 * `orders_30d` counted `order.completed` and the reverse-ETL writeback
 * counted it too. The catalog has no such event, so the ingester rejects
 * one as `unknown_event` — both definitions aggregated a name nothing
 * could emit, produced no rows, and left the `recent_purchasers` audience
 * empty and Braze idle. Every layer in isolation was correct.
 *
 * Neither the table lint nor `check-catalog-sql.mjs` could see it: the
 * table was real, the columns were real, and `'order.completed'` is a
 * string. EXPLAIN validates the shape of a query, never the meaning of
 * its constants.
 */
describe("event-name literals", () => {
  const KNOWN = new Set(["payment.approved", "checkout.started"]);

  it("flags an event the catalog does not register", () => {
    const problems = findTraitSqlProblems(
      "const t = `SELECT profile_id FROM polaris.profile_event_daily_counts " +
        "WHERE event = 'order.completed'`;",
      "t.ts",
      KNOWN,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]?.reason).toMatch(/does not register/);
  });

  it("accepts a registered one", () => {
    expect(
      findTraitSqlProblems(
        "const t = `SELECT profile_id FROM polaris.profile_event_daily_counts " +
          "WHERE event = 'payment.approved'`;",
        "t.ts",
        KNOWN,
      ),
    ).toEqual([]);
  });

  it("reads IN lists, not just equality", () => {
    const problems = findTraitSqlProblems(
      "const t = `SELECT profile_id FROM polaris.profile_event_daily_counts " +
        "WHERE event IN ('payment.approved', 'order.completed')`;",
      "t.ts",
      KNOWN,
    );
    expect(problems.map((p) => p.table)).toEqual(["order.completed"]);
  });

  it("extracts both literal forms", () => {
    expect([...eventLiteralsReferenced("WHERE event = 'a' OR event IN ('b','c')")].sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("checks nothing when the caller passes no set", () => {
    // The table rules stay usable on their own; only `main` has a catalog
    // to read from.
    expect(
      findTraitSqlProblems(
        "const t = `SELECT x FROM polaris.profile_event_daily_counts WHERE event = 'nope'`;",
        "t.ts",
      ),
    ).toEqual([]);
  });

  it("reads the real catalog, and refuses to pass on an empty one", () => {
    // The first version called `walk`, which collects `.ts` and skips
    // YAML — so it read zero events and flagged every definition in the
    // repo, including the correct ones. Failing closed was right; failing
    // SILENTLY closed was not, because it reads as a catalog full of bugs
    // rather than a check pointed at the wrong directory.
    const real = registeredEventNames(resolve(__dirname, "..", ".."));
    expect(real.has("payment.approved")).toBe(true);
    expect(real.has("checkout.started")).toBe(true);
    expect(real.has("order.completed")).toBe(false);

    expect(() => registeredEventNames(mkdtempSync(join(tmpdir(), "empty-")))).toThrow(
      /no registered events/,
    );
  });
});
