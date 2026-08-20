/**
 * Internal SQL helpers for the shared ClickHouse client.
 *
 * The package never interpolates user-supplied values into SQL strings. All
 * variable bindings go through ClickHouse's native `query_params` mechanism
 * (see https://clickhouse.com/docs/en/interfaces/http/#cli-queries-with-parameters)
 * so callers cannot accidentally inject SQL.
 *
 * These helpers exist so the shape of the generated SQL is testable in
 * isolation — the unit tests assert that, e.g. `replay.argMaxByEventKey`
 * emits SQL that contains `argMax(... , _version)` and `GROUP BY` on the
 * dedupe key, and does NOT contain `FINAL`.
 */

import { ClickHouseInvariantError } from "../errors.js";

/**
 * Identifier validator. ClickHouse identifiers must match
 * `[A-Za-z_][A-Za-z0-9_]*`. This is the column-name / table-name allowlist
 * we use whenever we splice identifiers into SQL (e.g. column lists in an
 * argMax SELECT). User-supplied values never reach this function.
 */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertIdentifier(value: string, role: string): string {
  if (!IDENTIFIER_RE.test(value)) {
    throw new ClickHouseInvariantError(
      `Invalid ClickHouse identifier for ${role}: ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

/**
 * Compose an `argMax(col, _version) AS col` projection for each column in the
 * provided list. Used by the replay reader so the SQL shape mirrors the
 * project's standard MV pattern.
 */
export function argMaxProjection(columns: readonly string[]): string {
  if (columns.length === 0) {
    throw new ClickHouseInvariantError("argMaxProjection requires at least one column.");
  }
  return columns
    .map((c) => {
      const safe = assertIdentifier(c, "argMax column");
      return `argMax(${safe}, _version) AS ${safe}`;
    })
    .join(",\n        ");
}

/**
 * Compose a `sum(col) AS col` projection for each column in the list.
 *
 * The SummingMergeTree counterpart to {@link argMaxProjection}, and it
 * exists for the same reason that one does: between merges the engine
 * holds several partial rows per sort key, and a reader that selected them
 * raw would report the same day's traffic as several smaller days. On a
 * ReplacingMergeTree that mistake ships duplicates; here it ships numbers
 * that are individually plausible and collectively wrong, which is worse
 * because nothing looks broken.
 *
 * `sum` and not `argMax`: the two engines disagree about what an unmerged
 * duplicate MEANS. A ReplacingMergeTree's extra rows are older versions of
 * one fact, so the newest wins. A SummingMergeTree's are addends of one
 * fact, so they add. Using the wrong idiom on either table returns a
 * number rather than an error.
 */
export function sumProjection(columns: readonly string[]): string {
  if (columns.length === 0) {
    throw new ClickHouseInvariantError("sumProjection requires at least one column.");
  }
  return columns
    .map((c) => {
      const safe = assertIdentifier(c, "sum column");
      return `sum(${safe}) AS ${safe}`;
    })
    .join(",\n        ");
}

/**
 * Validate that a generated SQL string does not contain the bare `FINAL`
 * keyword. This is a defense-in-depth check used by the internal SQL
 * builders. Callers using the escape hatch can include `FINAL` themselves;
 * that path bypasses this check by construction.
 */
export function assertNoFinal(sql: string, role: string): string {
  // `\bFINAL\b` matches the keyword. We also reject `\bfinal\b` lowercase to
  // catch accidental rewrites; ClickHouse SQL is case-insensitive for keywords.
  if (/\bfinal\b/i.test(sql)) {
    throw new ClickHouseInvariantError(
      `Internal SQL for ${role} contains FINAL keyword. persistence-clickhouse internal methods must not use FINAL; use argMax(_, _version) instead.`,
    );
  }
  return sql;
}

/**
 * Helper to render a comma-separated bound parameter list, e.g. ({eventIds:Array(String)}).
 *
 * ClickHouse parameter syntax: `{name:Type}`. We render the placeholder; the
 * caller passes the named param via `query_params`.
 */
export function bindArray(name: string, sqlType: string): string {
  assertIdentifier(name, "parameter name");
  if (!/^[A-Za-z][A-Za-z0-9()_, ]*$/.test(sqlType)) {
    throw new ClickHouseInvariantError(`Invalid SQL parameter type: ${JSON.stringify(sqlType)}.`);
  }
  return `{${name}:${sqlType}}`;
}

export function bindScalar(name: string, sqlType: string): string {
  return bindArray(name, sqlType);
}
