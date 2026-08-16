/**
 * Audience definitions — the semantic contract.
 *
 * An audience is a named population: "customers who ordered in the last 30
 * days", "people who have never converted". Membership is DERIVED, on a
 * schedule, from what the platform already concluded about a profile.
 *
 * ## Audiences read traits, not events
 *
 * The constraint that shapes everything here. A trait is already an
 * aggregate over history, computed on its own schedule against sanctioned
 * projections and stored on the profile. An audience over traits is
 * therefore a predicate over a small in-memory bag of values — cheap,
 * checkable by hand, and impossible to turn into a full scan by accident.
 *
 * The alternative — audiences querying raw events directly — would put a
 * second, differently-shaped aggregation path next to the trait runner,
 * computing overlapping numbers on the same cluster with no guarantee the
 * two agree. When `orders_30d` the trait and `orders_30d` the audience
 * predicate disagree, nobody can say which is wrong.
 *
 * A `projection` source exists for the case a population genuinely cannot
 * be expressed over traits. It runs the same lint-enforced allowlist as
 * trait SQL (`scripts/lint-trait-sql.mjs` covers this directory too), so
 * the escape hatch cannot quietly become a scan over `analytics_raw`.
 *
 * ## Versioning
 *
 * `version` is the definition's semantic revision. Bump it when the
 * predicate changes meaning; membership rows record which version last
 * evaluated them, and transition events carry the version that caused
 * them, so "why did this profile enter" is answerable months later.
 *
 * A bump does NOT re-enter everybody. Membership is membership; the
 * version stamps which definition last confirmed it. See
 * `async/computation/audiences/v1/src/diff.ts` for why churning the whole
 * population on a version bump would be the wrong reading.
 */

import { z } from "zod";

/** Where an audience gets its population. */
export const AUDIENCE_SOURCES = ["traits", "projection"] as const;
export type AudienceSource = (typeof AUDIENCE_SOURCES)[number];

/**
 * Comparison operators available to a trait predicate.
 *
 * Closed, and deliberately small. Every operator here is one an author can
 * reason about against a single trait value; anything needing more is
 * asking for a trait, not a richer predicate language. A predicate DSL that
 * grows arithmetic and string functions has reinvented SQL without the
 * query planner or the lint.
 */
export const AUDIENCE_OPERATORS = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "exists",
  "absent",
] as const;
export type AudienceOperator = (typeof AUDIENCE_OPERATORS)[number];

/** Trait keys look like trait keys — same rule as `catalog/traits`. */
const traitKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,62}[a-z0-9]$/, "trait key must be lower snake_case");

/** Values a predicate may compare against. No objects: traits compare flat. */
const comparableSchema = z.union([z.string(), z.number(), z.boolean()]);

/** `trait op value` — the leaf of a predicate. */
export const audienceComparisonSchema = z
  .union([
    z
      .object({
        trait: traitKeySchema,
        op: z.enum(["eq", "ne", "gt", "gte", "lt", "lte"]),
        value: comparableSchema,
      })
      .strict(),
    z
      .object({
        trait: traitKeySchema,
        op: z.literal("in"),
        values: z.array(comparableSchema).min(1).max(1000),
      })
      .strict(),
    z
      .object({
        trait: traitKeySchema,
        op: z.enum(["exists", "absent"]),
      })
      .strict(),
  ])
  .describe("One comparison against one trait");

export type AudienceComparison = z.infer<typeof audienceComparisonSchema>;

/**
 * A predicate: a comparison, or a combination of them.
 *
 * Recursive, so `z.lazy` is unavoidable; bounded by `MAX_PREDICATE_DEPTH`
 * at validation time so a definition cannot be nested deeply enough to
 * make evaluation interesting.
 */
export type AudiencePredicate =
  | AudienceComparison
  | { readonly all: readonly AudiencePredicate[] }
  | { readonly any: readonly AudiencePredicate[] }
  | { readonly not: AudiencePredicate };

export const audiencePredicateSchema: z.ZodType<AudiencePredicate> = z.lazy(() =>
  z.union([
    audienceComparisonSchema,
    z.object({ all: z.array(audiencePredicateSchema).min(1).max(64) }).strict(),
    z.object({ any: z.array(audiencePredicateSchema).min(1).max(64) }).strict(),
    z.object({ not: audiencePredicateSchema }).strict(),
  ]),
);

/** How deep a predicate may nest. */
export const MAX_PREDICATE_DEPTH = 8;

/** Every trait key a predicate reads, deduped. */
export function traitsReferenced(predicate: AudiencePredicate): readonly string[] {
  const keys = new Set<string>();
  const walk = (node: AudiencePredicate): void => {
    if ("all" in node) {
      for (const child of node.all) walk(child);
      return;
    }
    if ("any" in node) {
      for (const child of node.any) walk(child);
      return;
    }
    if ("not" in node) {
      walk(node.not);
      return;
    }
    keys.add(node.trait);
  };
  walk(predicate);
  return [...keys];
}

/** Depth of the deepest branch. */
export function predicateDepth(predicate: AudiencePredicate): number {
  if ("all" in predicate) {
    return 1 + Math.max(...predicate.all.map(predicateDepth));
  }
  if ("any" in predicate) {
    return 1 + Math.max(...predicate.any.map(predicateDepth));
  }
  if ("not" in predicate) {
    return 1 + predicateDepth(predicate.not);
  }
  return 1;
}

const baseDefinitionSchema = {
  /**
   * Storage key. Stable: renaming one orphans every membership row
   * recorded under the old name, and the runner cannot tell an orphan from
   * a population that legitimately emptied.
   */
  key: z.string().regex(/^[a-z][a-z0-9_]{1,62}[a-z0-9]$/, "audience key must be lower snake_case"),
  /** Semantic revision. Bump when the predicate changes meaning. */
  version: z.number().int().positive().max(1000),
  /** One line, shown by `polaris audiences show`. */
  description: z.string().min(1).max(512),
};

export const audienceDefinitionSchema = z
  .discriminatedUnion("source", [
    z
      .object({
        ...baseDefinitionSchema,
        source: z.literal("traits"),
        predicate: audiencePredicateSchema,
      })
      .strict(),
    z
      .object({
        ...baseDefinitionSchema,
        source: z.literal("projection"),
        /**
         * SQL returning a single `profile_id` column: the population.
         * Parameterised with `{project:String}` and `{environment:String}`,
         * exactly like trait SQL, and held to the same table allowlist by
         * `scripts/lint-trait-sql.mjs`.
         */
        sql: z.string().min(1),
      })
      .strict(),
  ])
  .superRefine((definition, ctx) => {
    if (definition.source !== "traits") return;
    const depth = predicateDepth(definition.predicate);
    if (depth > MAX_PREDICATE_DEPTH) {
      ctx.addIssue({
        code: "custom",
        message: `predicate nests ${String(depth)} deep; max is ${String(MAX_PREDICATE_DEPTH)}`,
        path: ["predicate"],
      });
    }
  });

export type AudienceDefinition = z.infer<typeof audienceDefinitionSchema>;
