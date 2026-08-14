import { describe, expect, it } from "vitest";

import {
  IdentityPolicyError,
  MANIFEST_DEFAULTS,
  createPolicyResolver,
  resolveIdentityPolicy,
} from "../src/policy.js";

describe("identity policy", () => {
  it("falls back to manifest defaults for a project that declared nothing", () => {
    // Which is every project until someone has a reason to think about
    // identity bounds — the defaults must be safe on their own.
    const policy = resolveIdentityPolicy(undefined);
    expect(policy.maxIdentifiersPerKind).toBe(MANIFEST_DEFAULTS.maxIdentifiersPerKind);
    expect(policy.maxMergesPerWindow).toBe(MANIFEST_DEFAULTS.maxMergesPerWindow);
    expect(policy.denylist).toEqual({});
  });

  it("accepts a project narrowing a bound", () => {
    const policy = resolveIdentityPolicy({ max_identifiers_per_kind: 10 });
    expect(policy.maxIdentifiersPerKind).toBe(10);
  });

  it("refuses a value outside the manifest bounds instead of clamping it", () => {
    // Silently clamping would leave the project believing it got what it
    // asked for, and the mismatch would only surface in an audit of
    // emitted events.
    expect(() => resolveIdentityPolicy({ max_identifiers_per_kind: 0 })).toThrow(
      IdentityPolicyError,
    );
    expect(() => resolveIdentityPolicy({ max_identifiers_per_kind: 99_999 })).toThrow(
      IdentityPolicyError,
    );
    expect(() => resolveIdentityPolicy({ merge_window_seconds: 1 })).toThrow(IdentityPolicyError);
  });

  it("builds a denylist set per identifier kind", () => {
    const policy = resolveIdentityPolicy({
      denylist: { customer_id: ["guest", "anonymous"], anonymous_id: ["kiosk-shared"] },
    });
    expect(policy.denylist.customer_id?.has("guest")).toBe(true);
    expect(policy.denylist.customer_id?.has("real_customer")).toBe(false);
    expect(policy.denylist.anonymous_id?.has("kiosk-shared")).toBe(true);
  });

  it("resolves per project and caches, since policy is deploy-time", () => {
    const resolver = createPolicyResolver(
      new Map([["storefront", { max_identifiers_per_kind: 5 }]]),
    );
    expect(resolver("storefront", "development").maxIdentifiersPerKind).toBe(5);
    // A project with no override still gets a usable policy.
    expect(resolver("other", "development").maxIdentifiersPerKind).toBe(
      MANIFEST_DEFAULTS.maxIdentifiersPerKind,
    );
    // Cached instance is reused (identity check, not just equality).
    expect(resolver("storefront", "development")).toBe(resolver("storefront", "production"));
  });

  it("refuses an invalid override at construction, so the boot fails — not the feed", () => {
    // Lazy resolution would throw on the FIRST MESSAGE from the project,
    // inside the consumer handler, cycling its whole feed through the
    // retry tiers into the DLQ over a configuration mistake. Deploy-time
    // inputs fail the deploy.
    expect(() => createPolicyResolver(new Map([["storefront", { max_traits_bytes: 1 }]]))).toThrow(
      IdentityPolicyError,
    );
    expect(() => createPolicyResolver(new Map([["storefront", { max_traits_bytes: 1 }]]))).toThrow(
      /project "storefront"/,
    );
  });
});
