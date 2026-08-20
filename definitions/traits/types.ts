/**
 * Computed trait definitions — the semantic contract.
 *
 * A trait is something Polaris CONCLUDES about a person from their history:
 * `orders_30d`, `lifetime_value`, `days_since_last_purchase`. Producers do
 * not send these; the platform computes them on a schedule and the profile
 * carries the answer.
 *
 * ## Definitions are code, and the SQL reads PROJECTIONS ONLY
 *
 * The constraint that shapes everything here. A trait's SQL may read
 * `event_daily_counts` and `session_daily_metrics`; it may not read
 * `analytics_raw` or `analytics_processed`.
 *
 * Not a style preference. `analytics_raw` is the widest table in the
 * warehouse and holds raw customer data — an open query against it is a
 * full scan over PII on a shared cluster, run on a cron, by a service-role
 * client that has no business reading it. Projections are narrow,
 * pre-aggregated, and already the thing the service role is granted. A
 * trait that genuinely needs a new shape of history should get a new
 * projection, which is a reviewable artifact, rather than a bespoke scan
 * nobody sees until it is slow.
 *
 * `scripts/lint-trait-sql.mjs` enforces this. It is a lint rather than a
 * runtime check because the failure it prevents — a heavy query landing on
 * a production cluster at 03:00 — is one nobody is awake for.
 *
 * ## The result contract
 *
 * Each definition's SQL returns exactly two columns:
 *
 *   profile_id   UUID
 *   value        the trait's value, of the declared type
 *
 * One row per profile with a value. A profile absent from the result has no
 * value for the trait, which the runner writes as a REMOVAL rather than a
 * zero — "this customer has made no orders in 30 days" and "we do not know"
 * are different facts, and a trait that silently defaulted would make the
 * first indistinguishable from the second.
 */

import { z } from "zod";

/** Trait value types. Closed, because the profile store's jsonb is not. */
export const TRAIT_TYPES = ["number", "string", "boolean", "timestamp"] as const;
export type TraitType = (typeof TRAIT_TYPES)[number];

/**
 * Projections a trait may read.
 *
 * A closed list rather than "anything but analytics_raw": a new projection
 * is a deliberate addition, and an allowlist makes adding one a decision
 * somebody makes rather than a table somebody happens to name.
 */
export const READABLE_PROJECTIONS = [
  "event_daily_counts",
  "session_daily_metrics",
  // The person-dimensioned projection. Without it no per-profile trait is
  // computable at all, which is not hypothetical: `orders_30d` selected
  // `profile_id` from `event_daily_counts`, which has no such column, and
  // had never produced a row.
  "profile_event_daily_counts",
] as const;

export const traitDefinitionSchema = z
  .object({
    /**
     * Storage key on `profile.traits`. Snake_case, and stable: renaming one
     * orphans the values already written under the old name, which no
     * migration here can fix because the runner cannot tell an old value
     * from a hand-set one.
     */
    key: z.string().regex(/^[a-z][a-z0-9_]{1,62}[a-z0-9]$/, "trait key must be lower snake_case"),
    type: z.enum(TRAIT_TYPES),
    /** One line, shown by `polaris traits list`. */
    description: z.string().min(1).max(512),
    /**
     * SQL returning `(profile_id, value)`. Parameterised with
     * `{project:String}` and `{environment:String}`; the runner supplies
     * both and nothing else, so a definition cannot smuggle in a scope.
     */
    sql: z.string().min(1),
    /**
     * How far back the computation looks, in days. Declared rather than
     * embedded in the SQL so `polaris traits list` can show it and an
     * operator can see which traits a retention change would affect.
     */
    windowDays: z.number().int().positive().max(3650),
  })
  .strict();

export type TraitDefinition = z.infer<typeof traitDefinitionSchema>;
