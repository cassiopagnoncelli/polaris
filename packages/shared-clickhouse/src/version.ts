/**
 * The `_version` scheme for `analytics_raw` / `analytics_processed`.
 *
 * Both tables are `ReplacingMergeTree(_version)`: rows sharing the sort
 * key `(project_id, environment, event, event_id)` collapse at merge
 * time and the highest `_version` survives. That column decides which
 * copy of a fact is the truth, and until now nothing set it — every row
 * arrived as `0` and the MVs applied a fallback of `ingested_at` in
 * milliseconds. The `analytics_raw` DDL has described the column as
 * "set by the analytics processor" since it was written; this module is
 * that description becoming true.
 *
 * ## Why it matters now
 *
 * The M3 dual-run puts the SAME event on two feeds at once: the legacy
 * `analytics.events` path and the spine's `resolved.events`. They share
 * an `event_id` — deliberately, because they are two sightings of one
 * fact, not two facts — so they share a sort key and collapse into each
 * other. And because the spine preserves `ingested_at` verbatim, the
 * fallback gives them the SAME `_version` too. ReplacingMergeTree
 * breaks a tie arbitrarily, so the surviving row would be a coin flip
 * between one that carries `profile_id` and one that does not.
 *
 * ## The layout
 *
 *   _version = (stage_rank * 2^48) + ingested_at_ms
 *
 * High bits name the producer, low bits keep it ordered by ingest time.
 * `2^48` ms is the year 10889, so the timestamp cannot climb into the
 * rank field; the whole value stays a safe integer in JavaScript up to
 * rank 31, and the two ranks defined here are 0 and 1.
 *
 * Three properties fall out, and each is load-bearing:
 *
 *   - a resolved row always outranks the legacy row for the same event,
 *     whatever their timestamps, so the row carrying `profile_id` wins
 *     the collapse every time rather than usually;
 *   - rank 0 reproduces the old fallback EXACTLY, so legacy rows already
 *     in the table keep the version they were merged under and nothing
 *     needs backfilling;
 *   - the value is a pure function of (stage, ingested_at), and
 *     `ingested_at` is preserved verbatim across the spine, so a replay
 *     re-derives the same number. Replays therefore collapse onto the
 *     original row instead of ratcheting a version forward on every
 *     rerun — which is what makes replay-as-repair safe to run twice.
 *
 * ## Why the sink computes this, and not the spine
 *
 * The plan sketched the enrichment stage stamping `_version` onto the
 * envelope. It is one line either way, and this is the better line:
 * `_version` is a ReplacingMergeTree implementation detail, and the
 * canonical envelope is a contract shared by every SDK, destination and
 * consumer in the product. Putting a warehouse column on it would make
 * every one of them carry a field only ClickHouse reads, and would need
 * a new platform-owned field on a `.strict()` schema to do it. The sink
 * already knows which family a row arrived on, which is the only input
 * the scheme needs.
 */

/**
 * Producer ranks. The value is part of the storage format: changing a
 * rank re-orders rows already merged under the old one.
 *
 * Ranks are deliberately sparse in meaning rather than dense in value —
 * a new feed that must win over `resolved.events` takes rank 2, and one
 * that must lose to it takes a rank between 0 and 1, which is why the
 * two defined ranks are not adjacent to any ceiling.
 *
 * Module-private: the value is an implementation detail of
 * `buildClickHouseVersion`, and a caller reaching for the raw rank would
 * be reimplementing the layout. The type derived from it travels; the
 * numbers do not.
 */
const CLICKHOUSE_VERSION_STAGE_RANKS = {
  /**
   * The legacy `analytics.events` feed and any writer that sets nothing.
   * Rank 0 reproduces the MVs' `ingested_at` fallback byte for byte, so
   * rows written before this scheme existed sort identically under it.
   */
  legacy: 0,
  /**
   * The spine's `resolved.events`. Outranks legacy for the same event,
   * which is the whole point: only this row carries `profile_id`.
   */
  resolved: 1,
} as const;

export type ClickHouseVersionStage = keyof typeof CLICKHOUSE_VERSION_STAGE_RANKS;

/**
 * Bits reserved for the millisecond timestamp. 2^48 ms is the year
 * 10889; the rank starts above it.
 */
const TIMESTAMP_BITS = 2 ** 48;

/**
 * Compute the `_version` for a row.
 *
 * `ingestedAt` is the envelope's `ingested_at` — when Polaris received
 * the fact, not when this sink saw it. Using the sink's clock would make
 * the value depend on when a batch happened to flush, so a replay would
 * outrank the original and every rerun would ratchet the version
 * forward.
 *
 * Falls back to rank-0 behaviour for an unparseable timestamp: the MVs
 * still apply their own `if (_version = 0, ...)` guard, so a `0` here is
 * caught downstream rather than sorting a row to the bottom forever.
 */
export function buildClickHouseVersion(input: {
  readonly stage: ClickHouseVersionStage;
  readonly ingestedAt: string;
}): number {
  const ms = Date.parse(input.ingestedAt);
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return CLICKHOUSE_VERSION_STAGE_RANKS[input.stage] * TIMESTAMP_BITS + ms;
}
