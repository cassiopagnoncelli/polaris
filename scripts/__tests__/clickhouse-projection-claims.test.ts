import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards the arithmetic claim the incremental projections make about
 * themselves.
 *
 * The projections are the only tables `polaris_service` is granted to read,
 * and the SummingMergeTree ones are fed by
 * a materialized view that emits a constant `1` per group. A materialized
 * view sees one insert block, so a duplicate arriving in a later block —
 * every redelivery, rewind and crash-replay — forms its own group, emits
 * another `+1`, and SummingMergeTree adds it. The counters over-count, and
 * the base table's ReplacingMergeTree collapse never reaches them because an
 * MV fires on insert, not on merge.
 *
 * Both files used to assert the opposite: "One distinct event_id contributes
 * exactly one", and "duplicates across blocks are folded by SummingMergeTree"
 * — the latter followed immediately by a parenthetical describing the summing
 * that causes the bug. Nobody checked, because a comment in that register
 * reads as an audit that already happened.
 *
 * A real two-block INSERT test needs a live ClickHouse and belongs in the
 * Docker-gated tier. This runs everywhere and catches the thing that actually
 * went wrong: the claim drifting back.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MV_DIR = join(ROOT, "db", "clickhouse", "materialized-views");
const PROJECTION_DIR = join(ROOT, "db", "clickhouse", "projections");
const GRANTS_FILE = join(ROOT, "db", "clickhouse", "roles", "01_grants.sql");
const SINK_SOURCE = join(ROOT, "libs", "persistence", "clickhouse", "src", "sink.ts");

/**
 * The grants file with its `--` comments removed.
 *
 * Every matcher below runs over this rather than the raw text. The file is
 * heavily commented — deliberately, it is the security policy — and those
 * comments name roles and privileges in prose. A regex spanning `[^;]*`
 * happily matches "SELECT" in one sentence and "polaris_sink" in the next,
 * which is how the write-only assertion first failed against a correct
 * file.
 */
function grantStatements(): string {
  return readFileSync(GRANTS_FILE, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

function read(dir: string, file: string): string {
  return readFileSync(join(dir, file), "utf8");
}

function sqlFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".sql"));
}

/** Comment text only — the SQL body legitimately contains GROUP BY etc. */
function comments(source: string): string {
  return source
    .split("\n")
    .filter((line) => line.trimStart().startsWith("--"))
    .join("\n");
}

/** MVs that feed a SummingMergeTree projection by emitting a constant. */
const CONSTANT_EMITTING_MVS = [
  "41_mv_raw_to_event_daily_counts.sql",
  "43_mv_processed_to_session_daily_metrics.sql",
];

describe("ClickHouse projection claims", () => {
  it.each(CONSTANT_EMITTING_MVS)("%s does not claim cross-block dedupe", (file) => {
    const text = comments(read(MV_DIR, file)).toLowerCase();

    // The exact false sentence, and the family it belongs to. A SummingMergeTree
    // sums; it cannot fold two rows it has no key to recognise as the same event.
    expect(text).not.toContain("folded by summingmergetree");
    expect(text).not.toMatch(/duplicates across blocks are (folded|deduped|collapsed)/);
    expect(text).not.toContain("contributes exactly one to event_count");
    expect(text).not.toContain("contributes exactly one to one counter");
  });

  it.each(CONSTANT_EMITTING_MVS)("%s states that its counters are approximate", (file) => {
    const text = comments(read(MV_DIR, file)).toLowerCase();
    expect(text).toContain("approximate");
    // And names the repair path, so a reader who needs an exact number knows
    // where to get one instead of trusting the projection.
    expect(text).toMatch(/rebuild/);
  });

  it("keeps event_id out of the projection sort keys, which is WHY they approximate", () => {
    // If a future change adds `event_id` to the ORDER BY, SummingMergeTree
    // could collapse per-event rows and the comments above would become
    // wrong in the other direction. Pin the current shape so that change is
    // deliberate rather than incidental.
    for (const file of sqlFiles(PROJECTION_DIR).filter((f) => !f.includes("rebuild"))) {
      const source = read(PROJECTION_DIR, file);
      if (!source.includes("SummingMergeTree")) continue;
      const orderBy = /ORDER BY \(([^)]*)\)/.exec(source)?.[1] ?? "";
      expect(orderBy, `${file} ORDER BY`).not.toContain("event_id");
    }
  });

  it("has a rebuild counterpart for every SummingMergeTree projection", () => {
    // The rebuild SELECT is the only exact answer available, so a projection
    // without one has no repair path at all.
    const files = sqlFiles(PROJECTION_DIR);
    for (const file of files.filter((f) => !f.includes("rebuild"))) {
      if (!read(PROJECTION_DIR, file).includes("SummingMergeTree")) continue;
      const expected = file.replace(/\.sql$/, "_rebuild.sql");
      expect(files, `${file} needs ${expected}`).toContain(expected);
    }
  });
});

/**
 * A projection the service role cannot read is a projection that does not
 * exist, from the caller's side.
 *
 * `profile_event_daily_counts` shipped without a grant. The table was
 * created, its materialized view filled it, and the trait lint's allowlist
 * named it as readable — so every check in the repo said the projection was
 * usable, and `polaris traits compute` failed with ACCESS_DENIED the first
 * time anyone ran it against a real cluster.
 *
 * `01_grants.sql` says "add another GRANT statement when a new projection
 * lands", and that instruction is the whole mechanism: a comment asking a
 * human to remember. This is the same shape as the rebuild-counterpart test
 * below it, for the same reason.
 */
describe("projection grants", () => {
  function grantedProjections(): Set<string> {
    const source = grantStatements();
    const granted = new Set<string>();
    // GRANT ... SELECT ON polaris.<table> ... TO polaris_service
    for (const match of source.matchAll(
      /GRANT[^;]*?SELECT\s+ON\s+polaris\.([a-z_]+)[^;]*?TO\s+polaris_service/gis,
    )) {
      if (match[1] !== undefined) granted.add(match[1]);
    }
    return granted;
  }

  function projectionTables(): string[] {
    const tables: string[] = [];
    for (const file of sqlFiles(PROJECTION_DIR)) {
      // The `_rebuild.sql` files INSERT into a table declared elsewhere.
      if (file.endsWith("_rebuild.sql")) continue;
      const match = /CREATE TABLE IF NOT EXISTS polaris\.([a-z_]+)/i.exec(
        read(PROJECTION_DIR, file),
      );
      if (match?.[1] !== undefined) tables.push(match[1]);
    }
    return tables;
  }

  it("grants polaris_service SELECT on every projection table", () => {
    const granted = grantedProjections();
    const missing = projectionTables().filter((table) => !granted.has(table));

    expect(missing).toEqual([]);
  });

  it("reads more than zero of each, so the check cannot pass vacuously", () => {
    // Both sides are regex-scraped. An expression that stopped matching
    // would make the assertion above trivially true — which is the failure
    // mode of every lint that compares two extracted lists.
    expect(projectionTables().length).toBeGreaterThan(0);
    expect(grantedProjections().size).toBeGreaterThan(0);
  });
});

/**
 * The sink must be able to INSERT into every table it inserts into.
 *
 * `profile_events_queue` and `violations_queue` both shipped without a
 * grant. The sink subscribes to `profile.events` and `rejected.events`,
 * and ClickHouse refused both writes — so it threw, rewound to its
 * checkpoint, retried the same message, and reported itself healthy
 * forever. The profile one was found by running the traits chain end to
 * end; the quarantine one was found only by asking what ELSE the sink
 * writes, which is what this asks now.
 *
 * The table list comes from `sink.ts` rather than from the SQL directory,
 * because the question is not "which Null tables exist" but "which ones
 * does the sink write" — a table nothing inserts into needs no grant, and
 * granting it would widen the role for no reason.
 */
describe("sink grants", () => {
  function sinkInsertGrants(): Set<string> {
    const source = grantStatements();
    const granted = new Set<string>();
    for (const match of source.matchAll(
      /GRANT[^;]*?INSERT\s+ON\s+polaris\.([a-z_]+)[^;]*?TO\s+polaris_sink/gis,
    )) {
      if (match[1] !== undefined) granted.add(match[1]);
    }
    return granted;
  }

  /** `export const X_QUEUE_TABLE = "name";` — the tables the sink writes. */
  function queueTablesTheSinkWrites(): string[] {
    const source = readFileSync(SINK_SOURCE, "utf8");
    return [...source.matchAll(/export const [A-Z_]*QUEUE_TABLE\s*=\s*"([a-z_]+)"/g)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined);
  }

  it("grants polaris_sink INSERT on every queue table the sink writes", () => {
    const granted = sinkInsertGrants();
    const missing = queueTablesTheSinkWrites().filter((table) => !granted.has(table));

    expect(missing).toEqual([]);
  });

  it("reads more than zero of each, so the check cannot pass vacuously", () => {
    expect(queueTablesTheSinkWrites().length).toBeGreaterThan(0);
    expect(sinkInsertGrants().size).toBeGreaterThan(0);
  });

  it("keeps polaris_sink write-only", () => {
    // The role exists to INSERT and nothing else; a SELECT grant on a Null
    // table would return empty and read as "no data ingested" during an
    // incident, which is the reasoning the grants file records.
    const selectsForSink = [
      ...grantStatements().matchAll(/GRANT[^;]*?SELECT[^;]*?TO\s+polaris_sink/gis),
    ];
    expect(selectsForSink).toEqual([]);
  });
});
