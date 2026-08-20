/**
 * The policy registry is the single map both enforcement points load. Its
 * tests are about the REGISTRY, not about policy semantics — the rules
 * themselves are covered in `libs/governance/test`.
 *
 * What matters here:
 *
 *   - the registered override is discoverable by `project_id`;
 *   - a project with no override resolves to platform defaults, which is
 *     the no-behaviour-change guarantee for every project that has not
 *     written one;
 *   - an illegal override fails at load, not at first event.
 */

import {
  evaluate,
  mergePolicy,
  PLATFORM_DEFAULT_POLICY,
  POLICY_REASON_POLICY,
  PolicyMergeError,
  type ProjectPolicyOverride,
} from "@polaris/shared-policy";
import { describe, expect, it } from "vitest";

import { checkoutOverride, PROJECT_POLICY_OVERRIDES } from "../index.js";

/**
 * The effective policy for a project, computed the way the enforcement
 * points compute it: look the override up in the registry, hand it to
 * `mergePolicy`. Deliberately a test helper rather than an exported
 * accessor — an accessor nothing but this file called is the shape the
 * dead-export check exists to surface.
 */
function effectivePolicyFor(projectId: string) {
  return mergePolicy(PROJECT_POLICY_OVERRIDES.get(projectId)).policy;
}

describe("policy registry", () => {
  it("registers the checkout override under its project_id", () => {
    expect(PROJECT_POLICY_OVERRIDES.get("checkout")).toBe(checkoutOverride);
  });

  it("keys every entry by the project_id declared inside the override", () => {
    // A file registered under the wrong key would be silently inert: the
    // enforcement points look up by the envelope's project_id.
    for (const [key, override] of PROJECT_POLICY_OVERRIDES) {
      expect(override.project_id).toBe(key);
    }
  });

  it("resolves an unregistered project to no override", () => {
    expect(PROJECT_POLICY_OVERRIDES.get("no-such-project")).toBeUndefined();
  });

  it("gives an unregistered project the platform defaults verbatim", () => {
    // The no-behaviour-change guarantee: wiring the registry must not
    // change policy for any project that did not write an override.
    expect(effectivePolicyFor("no-such-project")).toEqual(PLATFORM_DEFAULT_POLICY);
  });

  it("gives a registered project a policy strictly wider than the defaults", () => {
    const merged = effectivePolicyFor("checkout");
    expect(merged).not.toEqual(PLATFORM_DEFAULT_POLICY);
    // Additive only — every platform reject survives the merge.
    for (const platformRule of PLATFORM_DEFAULT_POLICY.reject) {
      expect(merged.reject.some((rule) => rule.field === platformRule.field)).toBe(true);
    }
  });
});

describe("policy registry — the checkout sample override is live", () => {
  it("rejects a field the platform defaults would have accepted", () => {
    const event = { project_id: "checkout", iban: "DE89370400440532013000" };

    const withDefaults = evaluate(event, {});
    expect(withDefaults.decision).toBe("accept");

    const withOverride = evaluate(event, { projectPolicy: checkoutOverride });
    expect(withOverride.decision).toBe("reject");
  });

  it("redacts a field the platform defaults would have carried in the clear", () => {
    const event = {
      project_id: "checkout",
      properties: { email: "shopper@example.com" },
    };

    const withDefaults = evaluate(event, {});
    expect(withDefaults.decision).toBe("accept");
    expect(withDefaults.decision === "accept" ? withDefaults.redactions : []).toHaveLength(0);

    const withOverride = evaluate(event, { projectPolicy: checkoutOverride });
    expect(withOverride.decision).toBe("accept");
    const redactions = withOverride.decision === "accept" ? withOverride.redactions : [];
    expect(redactions.map((r) => r.path.join("."))).toContain("properties.email");
  });
});

describe("policy registry — merge rules are enforced at load", () => {
  it("refuses an override that downgrades a platform reject without an exception", () => {
    const platformRejectField = PLATFORM_DEFAULT_POLICY.reject[0]?.field;
    expect(platformRejectField).toBeDefined();

    const illegal: ProjectPolicyOverride = {
      project_id: "reckless",
      redactNamed: [
        {
          field: platformRejectField as string,
          reason: POLICY_REASON_POLICY,
          note: "downgrade attempt with no documented exception",
        },
      ],
    };

    // This is the check `buildRegistry()` runs on every registered
    // override at module load, which is why an override like this one
    // crashes the ingester at boot rather than weakening policy silently.
    expect(() => mergePolicy(illegal)).toThrow(PolicyMergeError);
  });

  it("permits the same downgrade when a documented exception names the field", () => {
    const platformRejectField = PLATFORM_DEFAULT_POLICY.reject[0]?.field as string;

    const documented: ProjectPolicyOverride = {
      project_id: "deliberate",
      redactNamed: [
        {
          field: platformRejectField,
          reason: POLICY_REASON_POLICY,
          note: "downgrade with a documented exception",
        },
      ],
      documentedExceptions: [
        {
          field: platformRejectField,
          reviewer: "cassio",
          approved_at: "2026-08-16T00:00:00.000Z",
          rationale: "test fixture proving the exception path is the only way through",
        },
      ],
    };

    expect(() => mergePolicy(documented)).not.toThrow();
  });

  it("every registered override survives the merge it is validated with", () => {
    for (const override of PROJECT_POLICY_OVERRIDES.values()) {
      expect(() => mergePolicy(override)).not.toThrow();
    }
  });
});
