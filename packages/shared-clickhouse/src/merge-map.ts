/**
 * `polaris.profile_merge_map` reader/writer.
 *
 * Lives here rather than in the merge worker because raw SQL against
 * ClickHouse is confined to this package — `scripts/lint-clickhouse-imports`
 * enforces that only `packages/shared-clickhouse/` imports
 * `@clickhouse/client`. The worker gets a purpose-built surface, the same
 * shape the analytics sink and the projection readers get, and nobody
 * outside this package writes a query string.
 *
 * The table and the `polaris.profile_canonical` dictionary it backs are
 * defined in `sql/clickhouse/34_profile_merge_map.sql`; the reasoning for
 * resolving merges at read time instead of rewriting history is in
 * `docs/architecture/07-clickhouse.md` under "Retroactive Merges".
 */

import type { ClickHouseClient as UnderlyingClickHouseClient } from "@clickhouse/client";

export const MERGE_MAP_TABLE = "polaris.profile_merge_map";

/** One row of the map. Mirrors the DDL exactly. */
export interface MergeMapRow {
  readonly project_id: string;
  readonly environment: string;
  readonly loser_profile_id: string;
  readonly winner_profile_id: string;
  readonly merge_id: string;
  readonly reason: string;
  readonly merged_at: string;
  readonly _version: number;
}

/** An entry that currently resolves TO some profile. */
export interface MergeMapChainEntry {
  readonly loser_profile_id: string;
  readonly merge_id: string;
  readonly reason: string;
}

export interface MergeMapStore {
  /**
   * Rows whose winner is `profileId` — the entries a merge of that profile
   * invalidates, and therefore the ones the caller must rewrite.
   */
  chainedInto(input: {
    readonly projectId: string;
    readonly environment: string;
    readonly profileId: string;
  }): Promise<readonly MergeMapChainEntry[]>;
  upsert(rows: readonly MergeMapRow[]): Promise<void>;
}

export function createMergeMapStore(input: {
  underlying: UnderlyingClickHouseClient;
}): MergeMapStore {
  return {
    async chainedInto(query): Promise<readonly MergeMapChainEntry[]> {
      // Scoped to the project partition, and a scan within it — the sort key
      // is (project_id, environment, loser_profile_id), so a lookup BY WINNER
      // is not a point read. Acceptable because this runs once per merge, not
      // once per event, and the table holds one row per merge ever performed.
      // If a project ever accumulates enough merges for this to matter, the
      // answer is a second table keyed by winner, not an index here that
      // every transitive rewrite would have to maintain.
      //
      // FINAL because a loser already rewritten by an earlier transitive
      // merge would otherwise return both versions, and the caller would
      // rebuild a chain from a row it had already superseded.
      const result = await input.underlying.query({
        query: `SELECT loser_profile_id, merge_id, reason
                FROM ${MERGE_MAP_TABLE} FINAL
                WHERE project_id = {project:String}
                  AND environment = {environment:String}
                  AND winner_profile_id = {profile:UUID}`,
        query_params: {
          project: query.projectId,
          environment: query.environment,
          profile: query.profileId,
        },
        format: "JSONEachRow",
      });
      return (await result.json()) as MergeMapChainEntry[];
    },

    async upsert(rows): Promise<void> {
      if (rows.length === 0) return;
      await input.underlying.insert({
        table: MERGE_MAP_TABLE,
        values: rows,
        format: "JSONEachRow",
        clickhouse_settings: {
          // `merged_at` arrives as the envelope's ISO-8601 literal, with a
          // `T` separator and a trailing `Z`. The default
          // `date_time_input_format` is `basic`, which accepts neither and
          // fails the INSERT on the first row — the same trap the analytics
          // sink documents at length.
          date_time_input_format: "best_effort",
        },
      });
    },
  };
}
