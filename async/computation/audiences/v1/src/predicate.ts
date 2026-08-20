/**
 * Evaluating an audience predicate against one profile's traits.
 *
 * Pure, total, and deliberately boring. The interesting decisions are all
 * about what happens when a trait is ABSENT, which is the case a predicate
 * language usually gets wrong by defaulting.
 *
 * ## Absent is not zero, and not false
 *
 * `definitions/traits/types.ts` is explicit: a profile with no value for a
 * trait has no value, and that differs from having the value zero. The
 * runner writes absence as a removal rather than a default for exactly
 * this reason.
 *
 * So every comparison against an absent trait is FALSE — `eq`, `ne`, `gt`,
 * `lt`, all of them. Note that this makes `ne` non-classical: `orders_30d
 * ne 5` excludes a profile whose `orders_30d` is unknown, rather than
 * including it. That is the same three-valued logic SQL uses for NULL and
 * it is the right one here: "customers who have not ordered five times"
 * should not silently mean "everyone we have never computed", which on the
 * first run of a new trait is nearly the whole population.
 *
 * An author who genuinely wants "absent or not five" writes it:
 *
 *   { any: [ { trait: "orders_30d", op: "absent" },
 *            { trait: "orders_30d", op: "ne", value: 5 } ] }
 *
 * — which is longer, and says what it means.
 *
 * ## Type mismatches are false, not errors
 *
 * A predicate comparing a string trait with `gt: 5` evaluates to false
 * rather than throwing. A run that threw would fail the whole audience
 * because one profile's trait bag had an unexpected shape, and trait bags
 * are project-owned and not schema-checked. `polaris audiences show`
 * surfaces a population that has collapsed to zero, which is the signal an
 * operator can act on.
 */

import type { AudienceComparison, AudiencePredicate } from "@polaris/audience-catalog";

/** A profile's traits, as stored. */
export type TraitBag = Readonly<Record<string, unknown>>;

/** Does this profile satisfy the predicate? */
export function evaluatePredicate(predicate: AudiencePredicate, traits: TraitBag): boolean {
  if ("all" in predicate) {
    return predicate.all.every((child) => evaluatePredicate(child, traits));
  }
  if ("any" in predicate) {
    return predicate.any.some((child) => evaluatePredicate(child, traits));
  }
  if ("not" in predicate) {
    return !evaluatePredicate(predicate.not, traits);
  }
  return evaluateComparison(predicate, traits);
}

function evaluateComparison(comparison: AudienceComparison, traits: TraitBag): boolean {
  const present = Object.hasOwn(traits, comparison.trait);
  const value = present ? traits[comparison.trait] : undefined;
  // `null` counts as absent. A trait written as null is the project
  // saying "no value", and treating it as a comparable would make
  // `lt: 1` true for it in JavaScript's coercion rules.
  const known = present && value !== null && value !== undefined;

  if (comparison.op === "exists") return known;
  if (comparison.op === "absent") return !known;
  if (!known) return false;

  if (comparison.op === "in") {
    return comparison.values.some((candidate) => strictEquals(candidate, value));
  }
  if (comparison.op === "eq") return strictEquals(comparison.value, value);
  if (comparison.op === "ne") return !strictEquals(comparison.value, value);

  // Every remaining operator is an ordered one, and those all live in the
  // schema variant carrying `value`. The `in` check is what tells the
  // compiler so: `op` groups several literals per variant, so it is not a
  // discriminant TypeScript can narrow on by itself.
  if (!("value" in comparison)) return false;

  // Ordered comparisons need both sides to be numbers. Strings are not
  // ordered here on purpose: lexicographic ordering of trait values is
  // almost never what an author means, and silently providing it would
  // make `gt: "10"` quietly exclude "9".
  if (typeof value !== "number" || typeof comparison.value !== "number") return false;
  if (Number.isNaN(value) || Number.isNaN(comparison.value)) return false;

  switch (comparison.op) {
    case "gt":
      return value > comparison.value;
    case "gte":
      return value >= comparison.value;
    case "lt":
      return value < comparison.value;
    case "lte":
      return value <= comparison.value;
    default:
      return false;
  }
}

/**
 * Equality for trait comparison.
 *
 * Same type and same value. No coercion: `1 === "1"` being true here would
 * make an audience's membership depend on whether a producer sent a number
 * or a numeric string, which is not a distinction the marketer who wrote
 * the definition intended to make.
 */
function strictEquals(a: unknown, b: unknown): boolean {
  if (typeof a !== typeof b) return false;
  return a === b;
}
