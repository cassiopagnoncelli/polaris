import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMigrations,
  discoverMigrations,
  expandClientMacros,
  parseArgs,
  splitSqlStatements,
} from "../clickhouse-migrate.mjs";

/**
 * The ClickHouse migration runner is exercised against a temporary tree
 * shaped like sql/clickhouse/. The runner's network layer is injected
 * (`executor`) so the test never opens a real socket — we only assert
 * apply order, statement splitting, and error propagation.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "polaris-clickhouse-migrate-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seed(relPath: string, contents: string): void {
  const full = join(root, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

const SILENT_LOGGER = {
  info: () => undefined,
  error: () => undefined,
};

describe("splitSqlStatements", () => {
  it("returns a single statement when the input has no terminator", () => {
    expect(splitSqlStatements("SELECT 1")).toEqual(["SELECT 1"]);
  });

  it("splits on top-level semicolons and trims whitespace", () => {
    const sql = `
      CREATE DATABASE foo;
      CREATE TABLE foo.bar (x UInt32) ENGINE = MergeTree() ORDER BY x;
    `;
    const out = splitSqlStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("CREATE DATABASE foo");
    expect(out[1]).toContain("CREATE TABLE foo.bar");
  });

  it("ignores line comments (-- ...)", () => {
    const sql = `-- a leading comment\nSELECT 1;\n-- trailing`;
    expect(splitSqlStatements(sql)).toEqual(["SELECT 1"]);
  });

  it("ignores block comments (/* ... */)", () => {
    const sql = `/* outer\n*/SELECT 1; /* trailing */`;
    expect(splitSqlStatements(sql)).toEqual(["SELECT 1"]);
  });

  it("preserves semicolons inside single-quoted strings", () => {
    const sql = `SELECT 'a;b' AS x; SELECT 'c' AS y`;
    const out = splitSqlStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe("SELECT 'a;b' AS x");
    expect(out[1]).toBe("SELECT 'c' AS y");
  });

  it("preserves semicolons inside double-quoted identifiers", () => {
    const sql = `SELECT 1 AS "a;b"; SELECT 2`;
    const out = splitSqlStatements(sql);
    expect(out).toEqual([`SELECT 1 AS "a;b"`, "SELECT 2"]);
  });

  it("preserves semicolons inside backtick-quoted identifiers", () => {
    const sql = "SELECT 1 AS `a;b`; SELECT 2";
    const out = splitSqlStatements(sql);
    expect(out).toEqual(["SELECT 1 AS `a;b`", "SELECT 2"]);
  });

  it("handles doubled single quotes as an escape", () => {
    const sql = `SELECT 'it''s ok' AS x; SELECT 1`;
    const out = splitSqlStatements(sql);
    expect(out).toEqual([`SELECT 'it''s ok' AS x`, "SELECT 1"]);
  });

  it("returns an empty array for whitespace-only input", () => {
    expect(splitSqlStatements("   \n   ")).toEqual([]);
  });

  it("returns an empty array for comment-only input", () => {
    expect(splitSqlStatements("-- nothing here\n/* nor here */")).toEqual([]);
  });

  it("strips a trailing comment after the last statement", () => {
    const sql = `SELECT 1; -- final note`;
    expect(splitSqlStatements(sql)).toEqual(["SELECT 1"]);
  });
});

describe("discoverMigrations", () => {
  it("returns top-level files first, then subdirectories in declared order", () => {
    seed("00_database.sql", "CREATE DATABASE polaris;");
    seed("10_queue.sql", "-- queue\nSELECT 1;");
    seed("projections/40_daily.sql", "SELECT 1;");
    seed("materialized-views/41_mv.sql", "SELECT 1;");
    seed("roles/00_roles.sql", "CREATE ROLE x;");
    seed("roles/01_grants.sql", "GRANT SELECT ON polaris.* TO x;");

    const migrations = discoverMigrations(root);
    const order = migrations.map((m: { relativePath: string }) => m.relativePath);

    // Top-level first (lexicographic), then projections/, materialized-views/, roles/.
    expect(order).toEqual([
      "00_database.sql",
      "10_queue.sql",
      join("projections", "40_daily.sql"),
      join("materialized-views", "41_mv.sql"),
      join("roles", "00_roles.sql"),
      join("roles", "01_grants.sql"),
    ]);
  });

  it("sorts files within each directory lexicographically", () => {
    seed("20_b.sql", "SELECT 1;");
    seed("10_a.sql", "SELECT 1;");
    seed("30_c.sql", "SELECT 1;");

    const order = discoverMigrations(root).map((m: { relativePath: string }) => m.relativePath);
    expect(order).toEqual(["10_a.sql", "20_b.sql", "30_c.sql"]);
  });

  it("ignores non-.sql files", () => {
    seed("00_database.sql", "CREATE DATABASE polaris;");
    seed("README.md", "# notes");
    seed("ignored.txt", "ignored");

    const order = discoverMigrations(root).map((m: { relativePath: string }) => m.relativePath);
    expect(order).toEqual(["00_database.sql"]);
  });

  it("returns an empty array if no .sql files exist", () => {
    expect(discoverMigrations(root)).toEqual([]);
  });

  it("skips subdirectories that do not exist", () => {
    seed("00_database.sql", "CREATE DATABASE polaris;");
    // No projections/, materialized-views/, or roles/ directories.

    const order = discoverMigrations(root).map((m: { relativePath: string }) => m.relativePath);
    expect(order).toEqual(["00_database.sql"]);
  });

  it("skips *_rebuild.sql template files that aren't migrations", () => {
    // The clickhouse-rebuild driver ships projection SELECT templates
    // (e.g. projections/40_event_daily_counts_rebuild.sql) alongside the
    // canonical projection table DDL. Templates have unbound ClickHouse
    // parameters like `{partition:String}` and must not be executed by
    // the migration runner.
    seed(
      "projections/40_event_daily_counts.sql",
      "CREATE TABLE polaris.x (a UInt32) ENGINE = MergeTree ORDER BY a;",
    );
    seed(
      "projections/40_event_daily_counts_rebuild.sql",
      "SELECT a FROM polaris.x WHERE _partition_id = {partition:String};",
    );

    const order = discoverMigrations(root).map((m: { relativePath: string }) => m.relativePath);
    expect(order).toEqual([join("projections", "40_event_daily_counts.sql")]);
  });
});

describe("applyMigrations", () => {
  it("invokes the executor once per statement in apply order", async () => {
    seed("00_database.sql", "CREATE DATABASE polaris;");
    seed("10_queue.sql", "CREATE TABLE polaris.q (x UInt32) ENGINE = Memory; -- inline");
    seed("roles/00_roles.sql", "CREATE ROLE polaris_service;");

    const executor = vi.fn(async () => undefined);
    const result = await applyMigrations({
      root,
      client: { url: "http://x", user: "u", password: "p" },
      logger: SILENT_LOGGER,
      executor,
    });

    expect(executor).toHaveBeenCalledTimes(3);
    // Each call gets (client, statement). Confirm the statements landed in
    // apply order and were trimmed/comment-free. The mock is typed as
    // `MockedFunction<...>` whose argument tuple defaults to `[]` for a
    // bare `vi.fn(...)`, so we narrow via the runtime shape.
    const stmts = executor.mock.calls.map((c) => (c as unknown as [unknown, string])[1]);
    expect(stmts[0]).toBe("CREATE DATABASE polaris");
    expect(stmts[1]).toContain("CREATE TABLE polaris.q");
    expect(stmts[1]).not.toContain("-- inline");
    expect(stmts[2]).toBe("CREATE ROLE polaris_service");

    expect(result.applied.map((a: { relativePath: string }) => a.relativePath)).toEqual([
      "00_database.sql",
      "10_queue.sql",
      join("roles", "00_roles.sql"),
    ]);
    expect(result.totalStatements).toBe(3);
  });

  it("skips files that yield zero executable statements", async () => {
    seed("00_database.sql", "CREATE DATABASE polaris;");
    seed("99_empty.sql", "-- nothing but a comment");

    const executor = vi.fn(async () => undefined);
    const result = await applyMigrations({
      root,
      client: { url: "http://x", user: "u", password: "p" },
      logger: SILENT_LOGGER,
      executor,
    });

    expect(executor).toHaveBeenCalledTimes(1);
    expect(result.applied.map((a: { relativePath: string }) => a.relativePath)).toEqual([
      "00_database.sql",
    ]);
  });

  it("does not call the executor on dry-run", async () => {
    seed("00_database.sql", "CREATE DATABASE polaris;");

    const executor = vi.fn(async () => undefined);
    const result = await applyMigrations({
      root,
      client: { url: "http://x", user: "u", password: "p" },
      logger: SILENT_LOGGER,
      dryRun: true,
      executor,
    });

    expect(executor).not.toHaveBeenCalled();
    expect(result.applied).toHaveLength(1);
    expect(result.totalStatements).toBe(1);
  });

  it("wraps executor errors with file + statement context", async () => {
    seed("00_database.sql", "CREATE DATABASE polaris;");
    seed("10_bad.sql", "GOOD STATEMENT; BAD STATEMENT;");

    const executor = vi.fn(async (_client: unknown, stmt: string) => {
      if (stmt.startsWith("BAD")) {
        throw new Error("Syntax error near BAD");
      }
    });

    await expect(
      applyMigrations({
        root,
        client: { url: "http://x", user: "u", password: "p" },
        logger: SILENT_LOGGER,
        executor,
      }),
    ).rejects.toThrow(/10_bad\.sql statement 2\/2 failed.*Syntax error near BAD/s);
  });

  it("returns an empty summary when no migrations are discovered", async () => {
    const executor = vi.fn(async () => undefined);
    const result = await applyMigrations({
      root,
      client: { url: "http://x", user: "u", password: "p" },
      logger: SILENT_LOGGER,
      executor,
    });

    expect(executor).not.toHaveBeenCalled();
    expect(result.applied).toEqual([]);
    expect(result.totalStatements).toBe(0);
  });
});

describe("parseArgs", () => {
  it("parses --key=value flags", () => {
    expect(parseArgs(["--root=/tmp/foo", "--user=ch"])).toMatchObject({
      root: "/tmp/foo",
      user: "ch",
    });
  });

  it("parses bare --flag as true", () => {
    expect(parseArgs(["--dry-run"])).toMatchObject({ "dry-run": true });
  });

  it("collects positional arguments under _", () => {
    expect(parseArgs(["one", "--dry-run", "two"])).toMatchObject({
      _: ["one", "two"],
      "dry-run": true,
    });
  });
});

describe("end-to-end against the real sql/clickhouse/ tree", () => {
  // This test is a guardrail: if a future SQL file lands with a syntax that
  // the tokenizer cannot parse, the test fails fast in CI before the runner
  // is ever exercised against a live ClickHouse instance.
  it("discovers and tokenizes every file in the workspace's sql/clickhouse/", async () => {
    const repoRoot = join(__dirname, "..", "..");
    const sqlRoot = join(repoRoot, "sql", "clickhouse");
    const migrations = discoverMigrations(sqlRoot);

    expect(migrations.length).toBeGreaterThan(0);

    // Every migration must split into at least one non-empty statement;
    // otherwise the file is dead weight and should be removed.
    for (const m of migrations) {
      const stmts = splitSqlStatements(m.sql);
      expect(stmts.length, `${m.relativePath} produced zero executable statements`).toBeGreaterThan(
        0,
      );
    }

    // The four canonical layer files MUST be present, in order.
    const order = migrations.map((m: { relativePath: string }) => m.relativePath);
    const required = [
      "00_database.sql",
      "10_analytics_events_queue.sql",
      "20_analytics_ingest_log.sql",
      "30_analytics_raw.sql",
    ];
    for (const r of required) {
      expect(order, `${r} must be present in apply order`).toContain(r);
    }
    // Roles must come after the projection MV (so grants can reference
    // concrete tables).
    const lastRoles = order.findIndex((name: string) => name === join("roles", "01_grants.sql"));
    const firstProjection = order.findIndex(
      (name: string) =>
        name.startsWith("projections/") ||
        name.startsWith(`projections${require("node:path").sep}`),
    );
    if (firstProjection !== -1 && lastRoles !== -1) {
      expect(lastRoles, "roles/01_grants.sql must apply after projection tables").toBeGreaterThan(
        firstProjection,
      );
    }
  });
});

describe("expandClientMacros", () => {
  const originalReplicated = process.env["POLARIS_CLICKHOUSE_REPLICATED"];

  afterEach(() => {
    if (originalReplicated === undefined) {
      delete process.env["POLARIS_CLICKHOUSE_REPLICATED"];
    } else {
      process.env["POLARIS_CLICKHOUSE_REPLICATED"] = originalReplicated;
    }
  });

  it("expands {replicated} to '' by default (local engine family)", () => {
    delete process.env["POLARIS_CLICKHOUSE_REPLICATED"];
    expect(expandClientMacros("ENGINE = {replicated}MergeTree")).toBe("ENGINE = MergeTree");
  });

  it("expands {replicated} to its env-var value when set (production)", () => {
    process.env["POLARIS_CLICKHOUSE_REPLICATED"] = "Replicated";
    expect(expandClientMacros("ENGINE = {replicated}ReplacingMergeTree(_version)")).toBe(
      "ENGINE = ReplicatedReplacingMergeTree(_version)",
    );
  });

  it("expands every occurrence in the input", () => {
    delete process.env["POLARIS_CLICKHOUSE_REPLICATED"];
    const sql =
      "CREATE TABLE a (x UInt32) ENGINE = {replicated}MergeTree;\n" +
      "CREATE TABLE b (x UInt32) ENGINE = {replicated}MergeTree;";
    expect(expandClientMacros(sql)).toBe(
      "CREATE TABLE a (x UInt32) ENGINE = MergeTree;\n" +
        "CREATE TABLE b (x UInt32) ENGINE = MergeTree;",
    );
  });

  it("leaves unrelated macro-like tokens alone (e.g. {cluster} is server-side)", () => {
    delete process.env["POLARIS_CLICKHOUSE_REPLICATED"];
    expect(expandClientMacros("CREATE TABLE x (y UInt32) ON CLUSTER '{cluster}'")).toBe(
      "CREATE TABLE x (y UInt32) ON CLUSTER '{cluster}'",
    );
  });

  it("no longer substitutes {kafka_brokers} — ClickHouse consumes nothing now", () => {
    // The Kafka Engine table is gone; async/warehouse/clickhouse-sink pushes
    // rows in. A leftover macro would silently survive into the DDL, so
    // the absence is asserted rather than assumed.
    expect(expandClientMacros("kafka_broker_list = '{kafka_brokers}'")).toBe(
      "kafka_broker_list = '{kafka_brokers}'",
    );
  });
});
