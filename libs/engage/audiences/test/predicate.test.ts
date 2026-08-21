/**
 * Predicate evaluation (C195TM1C).
 *
 * Most of these are absence tests. A predicate language's defaults around
 * missing values decide who ends up in an audience on the first run of a
 * new trait, and getting them wrong is silent — the population is simply
 * wrong, and nothing errors.
 */

import type { AudiencePredicate } from "@polaris/audience-catalog";
import { describe, expect, it } from "vitest";

import { evaluatePredicate } from "../src/predicate.js";

const MEMBER = { orders_30d: 3, tier: "gold", churned: false };

describe("evaluatePredicate — comparisons on a present trait", () => {
  it.each([
    ["eq", 3, true],
    ["eq", 4, false],
    ["ne", 4, true],
    ["ne", 3, false],
    ["gt", 2, true],
    ["gt", 3, false],
    ["gte", 3, true],
    ["lt", 4, true],
    ["lt", 3, false],
    ["lte", 3, true],
  ] as const)("%s %d -> %s", (op, value, expected) => {
    const predicate = { trait: "orders_30d", op, value } as AudiencePredicate;
    expect(evaluatePredicate(predicate, MEMBER)).toBe(expected);
  });

  it("matches a string trait by equality", () => {
    expect(evaluatePredicate({ trait: "tier", op: "eq", value: "gold" }, MEMBER)).toBe(true);
    expect(evaluatePredicate({ trait: "tier", op: "eq", value: "silver" }, MEMBER)).toBe(false);
  });

  it("matches a boolean trait by equality", () => {
    expect(evaluatePredicate({ trait: "churned", op: "eq", value: false }, MEMBER)).toBe(true);
  });

  it("supports membership in a value list", () => {
    expect(
      evaluatePredicate({ trait: "tier", op: "in", values: ["gold", "platinum"] }, MEMBER),
    ).toBe(true);
    expect(evaluatePredicate({ trait: "tier", op: "in", values: ["silver"] }, MEMBER)).toBe(false);
  });
});

describe("evaluatePredicate — absent is not zero", () => {
  it("fails every ordered comparison when the trait is absent", () => {
    for (const op of ["gt", "gte", "lt", "lte"] as const) {
      expect(evaluatePredicate({ trait: "missing", op, value: 0 }, MEMBER)).toBe(false);
    }
  });

  it("fails eq when the trait is absent", () => {
    expect(evaluatePredicate({ trait: "missing", op: "eq", value: 0 }, MEMBER)).toBe(false);
  });

  it("fails NE when the trait is absent, deliberately", () => {
    // Three-valued logic, as SQL does for NULL. "customers who have not
    // ordered five times" must not silently mean "everyone we have never
    // computed", which on a new trait's first run is nearly everyone.
    expect(evaluatePredicate({ trait: "missing", op: "ne", value: 5 }, MEMBER)).toBe(false);
  });

  it("gives the author an explicit way to say absent-or-not-equal", () => {
    const predicate: AudiencePredicate = {
      any: [
        { trait: "missing", op: "absent" },
        { trait: "missing", op: "ne", value: 5 },
      ],
    };
    expect(evaluatePredicate(predicate, MEMBER)).toBe(true);
  });

  it("treats null and undefined as absent", () => {
    const bag = { orders_30d: null, tier: undefined };
    expect(evaluatePredicate({ trait: "orders_30d", op: "exists" }, bag)).toBe(false);
    expect(evaluatePredicate({ trait: "orders_30d", op: "absent" }, bag)).toBe(true);
    // Without the null guard, JavaScript coercion makes this true.
    expect(evaluatePredicate({ trait: "orders_30d", op: "lt", value: 1 }, bag)).toBe(false);
  });

  it("distinguishes a zero value from an absent one", () => {
    // The distinction the whole trait contract rests on.
    const zero = { orders_30d: 0 };
    expect(evaluatePredicate({ trait: "orders_30d", op: "exists" }, zero)).toBe(true);
    expect(evaluatePredicate({ trait: "orders_30d", op: "eq", value: 0 }, zero)).toBe(true);
    expect(evaluatePredicate({ trait: "orders_30d", op: "exists" }, {})).toBe(false);
    expect(evaluatePredicate({ trait: "orders_30d", op: "eq", value: 0 }, {})).toBe(false);
  });
});

describe("evaluatePredicate — no coercion", () => {
  it("does not equate a number with its string form", () => {
    // Membership must not depend on whether a producer sent 3 or "3".
    expect(evaluatePredicate({ trait: "orders_30d", op: "eq", value: "3" }, MEMBER)).toBe(false);
  });

  it("refuses to order strings", () => {
    // Lexicographic ordering would make `gt: "10"` exclude "9".
    expect(evaluatePredicate({ trait: "tier", op: "gt", value: "a" }, MEMBER)).toBe(false);
  });

  it("returns false rather than throwing on a type mismatch", () => {
    // Trait bags are project-owned and not schema-checked; one odd bag
    // must not fail the whole audience.
    expect(() => evaluatePredicate({ trait: "tier", op: "gte", value: 5 }, MEMBER)).not.toThrow();
    expect(evaluatePredicate({ trait: "tier", op: "gte", value: 5 }, MEMBER)).toBe(false);
  });

  it("is false for a NaN trait value", () => {
    expect(evaluatePredicate({ trait: "n", op: "gte", value: 1 }, { n: Number.NaN })).toBe(false);
  });
});

describe("evaluatePredicate — boolean groups", () => {
  it("requires every branch of all", () => {
    const predicate: AudiencePredicate = {
      all: [
        { trait: "orders_30d", op: "gte", value: 1 },
        { trait: "tier", op: "eq", value: "gold" },
      ],
    };
    expect(evaluatePredicate(predicate, MEMBER)).toBe(true);
    expect(evaluatePredicate(predicate, { orders_30d: 3, tier: "silver" })).toBe(false);
  });

  it("requires one branch of any", () => {
    const predicate: AudiencePredicate = {
      any: [
        { trait: "tier", op: "eq", value: "platinum" },
        { trait: "orders_30d", op: "gte", value: 1 },
      ],
    };
    expect(evaluatePredicate(predicate, MEMBER)).toBe(true);
    expect(evaluatePredicate(predicate, { orders_30d: 0, tier: "silver" })).toBe(false);
  });

  it("inverts with not", () => {
    const predicate: AudiencePredicate = { not: { trait: "tier", op: "eq", value: "gold" } };
    expect(evaluatePredicate(predicate, MEMBER)).toBe(false);
    expect(evaluatePredicate(predicate, { tier: "silver" })).toBe(true);
  });

  it("makes `not` over an absent trait true", () => {
    // Worth pinning: `not(eq)` and `ne` differ on absence. `eq` is false
    // for an absent trait, so `not(eq)` is true — which is the classical
    // reading and the opposite of `ne`. An author choosing between them
    // is choosing whether unknowns are included.
    expect(evaluatePredicate({ not: { trait: "missing", op: "eq", value: 5 } }, MEMBER)).toBe(true);
    expect(evaluatePredicate({ trait: "missing", op: "ne", value: 5 }, MEMBER)).toBe(false);
  });

  it("nests groups", () => {
    const predicate: AudiencePredicate = {
      all: [
        {
          any: [
            { trait: "tier", op: "eq", value: "gold" },
            { trait: "tier", op: "eq", value: "platinum" },
          ],
        },
        { not: { trait: "churned", op: "eq", value: true } },
      ],
    };
    expect(evaluatePredicate(predicate, MEMBER)).toBe(true);
    expect(evaluatePredicate(predicate, { tier: "gold", churned: true })).toBe(false);
  });
});
