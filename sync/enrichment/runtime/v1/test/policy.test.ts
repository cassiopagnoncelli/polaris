import { describe, expect, it } from "vitest";

import {
  createPolicyResolver,
  EnrichmentPolicyError,
  MANIFEST_DEFAULTS,
  resolveEnrichmentPolicy,
} from "../src/policy.js";

describe("enrichment policy", () => {
  it("falls back to the manifest default for a project that declared nothing", () => {
    const policy = resolveEnrichmentPolicy(undefined);
    expect(policy.maxTraitsBytes).toBe(MANIFEST_DEFAULTS.maxTraitsBytes);
  });

  it("accepts a project narrowing the snapshot guard", () => {
    expect(resolveEnrichmentPolicy({ max_traits_bytes: 4_096 }).maxTraitsBytes).toBe(4_096);
  });

  it("refuses a value outside the manifest bounds instead of clamping it", () => {
    // Silently clamping would leave the project believing it got what it
    // asked for, and the mismatch would surface only in an audit of
    // emitted events.
    expect(() => resolveEnrichmentPolicy({ max_traits_bytes: 8 })).toThrow(EnrichmentPolicyError);
    expect(() => resolveEnrichmentPolicy({ max_traits_bytes: 99_999_999 })).toThrow(
      EnrichmentPolicyError,
    );
  });

  it("refuses an invalid override at construction, so the boot fails — not the feed", () => {
    // Lazy resolution would throw on the first message from the project,
    // inside the consumer handler, cycling its whole feed through the
    // retry tiers into the DLQ over a configuration mistake.
    expect(() => createPolicyResolver(new Map([["storefront", { max_traits_bytes: 8 }]]))).toThrow(
      EnrichmentPolicyError,
    );
    expect(() => createPolicyResolver(new Map([["storefront", { max_traits_bytes: 8 }]]))).toThrow(
      /project "storefront"/,
    );
  });

  it("resolves per project and caches, since policy is deploy-time", () => {
    const resolver = createPolicyResolver(new Map([["storefront", { max_traits_bytes: 2_048 }]]));
    expect(resolver("storefront", "development").maxTraitsBytes).toBe(2_048);
    expect(resolver("other", "development").maxTraitsBytes).toBe(MANIFEST_DEFAULTS.maxTraitsBytes);
    expect(resolver("storefront", "development")).toBe(resolver("storefront", "production"));
  });
});
