import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards the arithmetic claim the incremental projections make about
 * themselves.
 *
 * `event_daily_counts` and `session_daily_metrics` are the ONLY tables
 * `polaris_service` is granted to read, and both are SummingMergeTree fed by
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
const MV_DIR = join(ROOT, "sql", "clickhouse", "materialized-views");
const PROJECTION_DIR = join(ROOT, "sql", "clickhouse", "projections");

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
