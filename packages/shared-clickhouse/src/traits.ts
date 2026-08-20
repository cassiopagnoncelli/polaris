/**
 * Running a computed-trait definition's SQL.
 *
 * Lives here because raw ClickHouse SQL is confined to this package by
 * `scripts/lint-clickhouse-imports`. The traits runner holds definitions,
 * not query strings.
 *
 * ## This is not an escape hatch
 *
 * The SQL is not operator input. It comes from `definitions/traits/`, which is
 * versioned code, and `scripts/lint-trait-sql.mjs` refuses any definition
 * reading a table outside the projection allowlist — `analytics_raw` and
 * `analytics_processed` in particular. So a definition cannot become a full
 * scan over raw customer data no matter what it says.
 *
 * That is why this belongs on the SERVICE client rather than behind the
 * operator `raw` namespace: the constraint is enforced before the query
 * exists, so the caller needs no elevated role and a nightly cron never
 * holds operator credentials.
 *
 * Only two parameters are bound — project and environment. A definition
 * cannot smuggle in a third, so it cannot widen its own scope past the one
 * the runner asked for.
 */

import type { ClickHouseClient as UnderlyingClickHouseClient } from "@clickhouse/client";

/** One row of a definition's result: the profile, and its value. */
export interface TraitQueryRow {
  readonly profile_id: string;
  readonly value: unknown;
}

export interface TraitQueryReader {
  run(input: {
    /** From `definitions/traits/`. Code, lint-constrained to projections. */
    readonly sql: string;
    readonly projectId: string;
    readonly environment: string;
  }): Promise<readonly TraitQueryRow[]>;
}

export function createTraitQueryReader(input: {
  readonly underlying: UnderlyingClickHouseClient;
}): TraitQueryReader {
  return {
    async run({ sql, projectId, environment }): Promise<readonly TraitQueryRow[]> {
      const result = await input.underlying.query({
        query: sql,
        query_params: { project: projectId, environment },
        format: "JSONEachRow",
      });
      return (await result.json()) as TraitQueryRow[];
    },
  };
}
