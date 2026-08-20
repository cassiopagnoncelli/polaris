/**
 * Reading the schema-governance quarantine.
 *
 * Lives here because raw ClickHouse SQL is confined to this package by
 * `scripts/lint-clickhouse-imports`. The CLI holds filters, not query
 * strings.
 *
 * ## Service role, not operator
 *
 * `polaris violations list` is a read-only diagnostic over a table that,
 * by construction, contains no unredacted values — the sample was
 * redacted in the ingester before it was published, and the paths are
 * paths. Requiring an operator token to read it would mean the people who
 * most need it, the ones whose producer is failing validation, would have
 * to escalate to find out why.
 *
 * Every filter is a bound parameter. The query shape is fixed here and
 * cannot be widened by a caller, which is what keeps this off the
 * operator `raw` namespace.
 */

import type { ClickHouseClient as UnderlyingClickHouseClient } from "@clickhouse/client";

/** One quarantined rejection, as an operator reads it. */
export interface ViolationRow {
  readonly violation_id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly event: string;
  readonly event_id: string;
  readonly reason: string;
  readonly paths: readonly string[];
  readonly redacted_sample: string;
  readonly received_at: string;
}

export interface ListViolationsFilter {
  readonly projectId: string;
  readonly environment?: string;
  /** Half-open lower bound on `received_at`. */
  readonly since?: Date;
  readonly until?: Date;
  readonly reason?: string;
  readonly event?: string;
  /** Hard cap. The reader clamps; the CLI also refuses larger values. */
  readonly limit?: number;
}

/** Rejections grouped for the "what changed?" question. */
export interface ViolationSummaryRow {
  readonly reason: string;
  readonly event: string;
  readonly violations: number;
}

export interface ViolationReader {
  list(filter: ListViolationsFilter): Promise<readonly ViolationRow[]>;
  /** Counts by reason and event over the same window. */
  summarise(filter: ListViolationsFilter): Promise<readonly ViolationSummaryRow[]>;
}

/**
 * Most rows one call returns.
 *
 * A quarantine under a broken deployment holds millions of rows, and an
 * unbounded `SELECT *` against it is how an operator diagnosing an
 * incident causes a second one.
 */
export const VIOLATIONS_MAX_LIMIT = 1_000;

export function createViolationReader(input: {
  readonly underlying: UnderlyingClickHouseClient;
}): ViolationReader {
  /**
   * The shared WHERE clause and its parameters.
   *
   * Built once for both queries so a filter can never mean one thing in
   * the listing and another in the summary — an operator comparing the
   * two would be comparing different windows without being told.
   */
  function scope(filter: ListViolationsFilter): {
    where: string;
    params: Record<string, unknown>;
  } {
    const clauses = ["project_id = {project:String}"];
    const params: Record<string, unknown> = { project: filter.projectId };

    if (filter.environment !== undefined) {
      clauses.push("environment = {environment:String}");
      params["environment"] = filter.environment;
    }
    if (filter.since !== undefined) {
      clauses.push("received_at >= {since:DateTime64(3)}");
      params["since"] = filter.since.toISOString();
    }
    if (filter.until !== undefined) {
      // Exclusive, so two adjacent windows neither overlap nor gap.
      clauses.push("received_at < {until:DateTime64(3)}");
      params["until"] = filter.until.toISOString();
    }
    if (filter.reason !== undefined) {
      clauses.push("reason = {reason:String}");
      params["reason"] = filter.reason;
    }
    if (filter.event !== undefined) {
      clauses.push("event = {event:String}");
      params["event"] = filter.event;
    }
    return { where: clauses.join(" AND "), params };
  }

  return {
    async list(filter): Promise<readonly ViolationRow[]> {
      const { where, params } = scope(filter);
      const limit = Math.min(filter.limit ?? VIOLATIONS_MAX_LIMIT, VIOLATIONS_MAX_LIMIT);
      const result = await input.underlying.query({
        query: `
          SELECT
            violation_id,
            project_id,
            environment,
            event,
            event_id,
            reason,
            paths,
            redacted_sample,
            -- Millisecond precision, matching every other timestamp Polaris
            -- emits. formatDateTime's fractional specifier renders SIX
            -- digits on a DateTime64(3): it parses fine, but it would make
            -- this the only ISO timestamp in the platform that looks
            -- different. (No backticks in this comment — it lives inside a
            -- JavaScript template literal, and one would end the string.)
            concat(
              formatDateTime(received_at, '%Y-%m-%dT%H:%i:%S'),
              '.',
              lpad(toString(toUnixTimestamp64Milli(received_at) % 1000), 3, '0'),
              'Z'
            ) AS received_at
          FROM polaris.violations
          WHERE ${where}
          ORDER BY received_at DESC
          LIMIT {limit:UInt32}
        `,
        query_params: { ...params, limit },
        format: "JSONEachRow",
      });
      return (await result.json()) as ViolationRow[];
    },

    async summarise(filter): Promise<readonly ViolationSummaryRow[]> {
      const { where, params } = scope(filter);
      const result = await input.underlying.query({
        query: `
          SELECT reason, event, count() AS violations
          FROM polaris.violations
          WHERE ${where}
          GROUP BY reason, event
          ORDER BY violations DESC
          LIMIT 100
        `,
        query_params: params,
        format: "JSONEachRow",
      });
      const rows = (await result.json()) as Array<{
        reason: string;
        event: string;
        violations: string | number;
      }>;
      // ClickHouse returns count() as a string in JSONEachRow. Coerced
      // here rather than at every call site, because a string that sorts
      // lexicographically is how "9" ends up above "10".
      return rows.map((row) => ({
        reason: row.reason,
        event: row.event,
        violations: Number(row.violations),
      }));
    },
  };
}
