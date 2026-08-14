/**
 * The `_version` scheme.
 *
 * These are the properties `analytics_raw`'s DDL comment now promises,
 * asserted rather than described — the previous comment promised
 * something nothing implemented, for the whole life of the table.
 */

import { describe, expect, it } from "vitest";

import { buildClickHouseVersion } from "../src/version.js";

const INGESTED = "2026-08-14T00:00:01.000Z";
const MS = Date.parse(INGESTED);

describe("_version scheme", () => {
  it("reproduces the MVs' ingest-ms fallback exactly at rank 0", () => {
    // The property that makes the migration additive: a legacy row and a
    // row the MV fell back on sort identically, so nothing already
    // merged needs backfilling or re-versioning.
    expect(buildClickHouseVersion({ stage: "legacy", ingestedAt: INGESTED })).toBe(MS);
  });

  it("ranks resolved strictly above legacy for the SAME event", () => {
    // The dual-run's whole problem: both feeds carry one event_id and —
    // because the spine preserves ingested_at verbatim — one timestamp.
    // Ties are resolved arbitrarily by ReplacingMergeTree, so without
    // the rank roughly half the surviving rows would lack profile_id.
    const legacy = buildClickHouseVersion({ stage: "legacy", ingestedAt: INGESTED });
    const resolved = buildClickHouseVersion({ stage: "resolved", ingestedAt: INGESTED });
    expect(resolved).toBeGreaterThan(legacy);
  });

  it("ranks resolved above legacy even when legacy is ingested much later", () => {
    // Rank dominates time, which is what makes the guarantee absolute
    // rather than usual. (Cross-event comparison is meaningless anyway —
    // `_version` only ever competes within one sort key — but a scheme
    // that merely *usually* wins would be a coin flip under clock skew.)
    const resolved = buildClickHouseVersion({ stage: "resolved", ingestedAt: INGESTED });
    const laterLegacy = buildClickHouseVersion({
      stage: "legacy",
      ingestedAt: "2099-01-01T00:00:00.000Z",
    });
    expect(resolved).toBeGreaterThan(laterLegacy);
  });

  it("stays ordered by ingest time within a stage", () => {
    const earlier = buildClickHouseVersion({ stage: "resolved", ingestedAt: INGESTED });
    const later = buildClickHouseVersion({
      stage: "resolved",
      ingestedAt: "2026-08-14T00:00:02.000Z",
    });
    expect(later).toBeGreaterThan(earlier);
    expect(later - earlier).toBe(1000);
  });

  it("is a pure function of its inputs, so a replay re-derives it", () => {
    // Built from the envelope's ingested_at rather than a wall clock. A
    // wall-clock version would make each rerun outrank the last and
    // ratchet the version forward forever, which is the opposite of what
    // replay-as-repair needs.
    expect(buildClickHouseVersion({ stage: "resolved", ingestedAt: INGESTED })).toBe(
      buildClickHouseVersion({ stage: "resolved", ingestedAt: INGESTED }),
    );
  });

  it("stays a safe integer, so JSON round-trips without precision loss", () => {
    // The value crosses the wire as JSON. Past 2^53 it would round on
    // the way in and rows would collapse against a version nobody wrote.
    const value = buildClickHouseVersion({
      stage: "resolved",
      ingestedAt: "2099-12-31T23:59:59.999Z",
    });
    expect(Number.isSafeInteger(value)).toBe(true);
    expect(JSON.parse(JSON.stringify(value))).toBe(value);
  });

  it("falls back to 0 for an unparseable timestamp, where the MV guard catches it", () => {
    for (const bad of ["", "not-a-date", "2026-13-45T99:99:99Z"]) {
      expect(buildClickHouseVersion({ stage: "resolved", ingestedAt: bad }), bad).toBe(0);
    }
  });

  it("pins the layout, because the ranks are part of the storage format", () => {
    // Asserted through the function rather than against the constant:
    // what must not drift is the VALUE a row is stored with, and the
    // constant is one refactor away from being multiplied differently.
    // Changing either number re-orders rows already merged under it.
    expect(buildClickHouseVersion({ stage: "legacy", ingestedAt: INGESTED })).toBe(MS);
    expect(buildClickHouseVersion({ stage: "resolved", ingestedAt: INGESTED })).toBe(2 ** 48 + MS);
  });
});
