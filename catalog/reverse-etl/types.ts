/**
 * What a reverse-ETL job is.
 *
 * A job reads warehouse rows and writes them back into Polaris as events.
 * Two halves, deliberately separated:
 *
 *   - the SQL is DATA: a string, lint-constrained to the same projection
 *     allowlist traits and audiences read, so a job cannot become a full
 *     scan over raw customer data whatever it says;
 *   - the mapping is CODE: `toEvent(row)` is a function, because turning a
 *     row into a canonical event is a decision with branches — a null
 *     column, a value that should be omitted rather than sent as null —
 *     and a config format expressive enough to encode those is a
 *     programming language with worse tooling.
 *
 * ## The events go through the ingester, not around it
 *
 * A runner that published straight to `raw.events` would skip validation,
 * the forbidden-field policy, dedupe, and the per-key rate limiter — every
 * guarantee the platform makes about what enters it. The plan forbids it
 * (SS12) and this contract has no way to express it: a job produces an
 * EVENT, and the only door for an event is the ingester.
 *
 * ## Loop safety
 *
 * Emitted events carry `source.type: "internal"`. A job's SQL reads
 * PROJECTIONS, which are fed from `analytics_raw` by materialized views,
 * so a writeback cannot re-trigger itself within a run: the row it would
 * read does not exist until the event it just emitted has traversed the
 * ingester, the spine, the sink and the view.
 *
 * It CAN re-trigger across runs — tomorrow's run sees today's writeback —
 * which is why `toEvent` is expected to be a pure function of the row.
 * A job whose output depends on its own previous output is a feedback
 * loop, and no framework can stop one; what this shape does is make it
 * visible in the diff.
 */

import { z } from "zod";

/**
 * Canonical events a job may emit.
 *
 * A closed set, and short on purpose. Reverse ETL exists to write TRAITS
 * back — "this customer's LTV is now X" — and `user.identified` is the
 * platform's trait-carrying event. A job that could emit `checkout.started`
 * would be a job that fabricates customer behaviour, and the warehouse row
 * behind it is an aggregate, not something a person did.
 */
export const REVERSE_ETL_EVENTS = ["user.identified"] as const;
export type ReverseEtlEvent = (typeof REVERSE_ETL_EVENTS)[number];

/** One row as the runner hands it to a mapping. */
export type ReverseEtlRow = Readonly<Record<string, unknown>>;

/**
 * What a mapping produces, or `null` to skip the row.
 *
 * `null` rather than throwing: a job over a million rows will meet a few
 * it cannot map — a null customer id, a value outside a sane range — and
 * one bad row must not fail the run. Skips are counted.
 */
export interface ReverseEtlMapped {
  readonly event: ReverseEtlEvent;
  /**
   * The customer this is about. Becomes `identity.customer_id`, which is
   * what lets the identity stage attach it to the right profile.
   */
  readonly customerId: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface ReverseEtlJob {
  readonly key: string;
  readonly version: number;
  readonly description: string;
  /**
   * Reads projections only; `scripts/lint-trait-sql.mjs` enforces it.
   * Bound parameters are `{project:String}` and `{environment:String}`,
   * and nothing else — a job cannot widen its own scope.
   */
  readonly sql: string;
  /** Row -> event, or `null` to skip. See `ReverseEtlMapped`. */
  readonly toEvent: (row: ReverseEtlRow) => ReverseEtlMapped | null;
}

/**
 * Validates the DATA half. `toEvent` is a function and is checked by the
 * compiler; everything a schema can usefully assert is here.
 */
export const reverseEtlJobSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  version: z.number().int().positive(),
  description: z.string().min(1).max(500),
  sql: z.string().min(1),
  toEvent: z.custom<ReverseEtlJob["toEvent"]>((value) => typeof value === "function", {
    message: "toEvent must be a function",
  }),
});

/**
 * Validate a registry at load.
 *
 * Duplicate keys are the failure worth catching here: two jobs under one
 * key means `polaris reverse-etl run <key>` silently runs whichever the
 * registry happened to list second.
 */
export function validateReverseEtlRegistry(jobs: readonly ReverseEtlJob[]): void {
  const seen = new Set<string>();
  for (const job of jobs) {
    reverseEtlJobSchema.parse(job);
    if (seen.has(job.key)) {
      throw new Error(`reverse-etl registry: duplicate job key "${job.key}"`);
    }
    seen.add(job.key);
  }
}
