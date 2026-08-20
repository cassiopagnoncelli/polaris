/**
 * Normalize v2: the profile block reaches the mapper.
 *
 * Two things are being pinned. The first is the identity PREFERENCE order,
 * which decides what every vendor keys a person on and is therefore the
 * change with the widest blast radius in this card. The second is that
 * traits obey the same redaction and hashing rules as properties — traits
 * arrive from the profile store rather than from the producer, and the
 * interesting question is whether that different provenance buys them a
 * weaker rule. It must not: it would be a hole cut in the redaction policy
 * by way of a different table.
 */

import { describe, expect, it } from "vitest";

import { normalizeForDestination, pickBestIdentity, prepareIdentity } from "../src/index.js";

import { buildEnvelope } from "./fixtures.js";

const PROFILE = {
  profile_id: "01930000-0000-7000-8000-0000000000aa",
  canonical_customer_id: "cus_canonical",
} as const;

function normalize(envelope: Parameters<typeof normalizeForDestination>[0]) {
  const outcome = normalizeForDestination(envelope, {
    destinationId: "polaris_dst_test",
    requiredConsent: {},
  });
  if (outcome.kind !== "normalized") throw new Error(`unexpected drop: ${outcome.reason}`);
  return outcome.normalized;
}

describe("identity preference", () => {
  it("prefers the platform's resolution over the producer's", () => {
    const normalized = normalize(buildEnvelope({ profile: PROFILE }));
    expect(normalized.best_identity).toEqual({
      kind: "canonical_customer_id",
      value: "cus_canonical",
    });
  });

  it("falls to profile_id when the person has no customer id", () => {
    // The common case for an anonymous visitor the platform has still
    // stitched across devices — there is no customer id to resolve, but
    // there is very much a person.
    const normalized = normalize(
      buildEnvelope({
        identity: { anonymous_id: "anon_1", session_id: null, customer_id: null, device_id: null },
        profile: { ...PROFILE, canonical_customer_id: null },
      }),
    );
    expect(normalized.best_identity).toEqual({
      kind: "profile_id",
      value: PROFILE.profile_id,
    });
  });

  it("still uses user_id on an envelope that never reached the spine", () => {
    // The regression this ordering exists to avoid. Every vendor not yet
    // flipped, and every replay of history, arrives with no profile block;
    // dropping user_id from the chain would silently demote all of it to
    // email_sha256 and change who each vendor thinks these events are about.
    const normalized = normalize(buildEnvelope());
    expect(normalized.best_identity).toEqual({ kind: "user_id", value: "cus_test" });
  });

  it("orders the whole chain", () => {
    const full = prepareIdentity({
      canonical_customer_id: "canon",
      profile_id: "prof",
      user_id: "user",
      anonymous_id: "anon",
      email: "someone@example.com",
    });
    expect(pickBestIdentity(full)?.kind).toBe("canonical_customer_id");
    expect(pickBestIdentity({ ...full, canonical_customer_id: null })?.kind).toBe("profile_id");
    expect(pickBestIdentity({ ...full, canonical_customer_id: null, profile_id: null })?.kind).toBe(
      "user_id",
    );
    expect(
      pickBestIdentity({ ...full, canonical_customer_id: null, profile_id: null, user_id: null })
        ?.kind,
    ).toBe("email_sha256");
  });

  it("treats an empty resolved id as absent rather than as an identity", () => {
    const normalized = normalize(
      buildEnvelope({ profile: { ...PROFILE, canonical_customer_id: "   " } }),
    );
    expect(normalized.best_identity.kind).toBe("profile_id");
  });
});

describe("traits", () => {
  it("passes non-PII traits through to the mapper", () => {
    const normalized = normalize(
      buildEnvelope({
        profile: { ...PROFILE, traits: { tier: "gold", lifetime_value: 4200 }, traits_version: 7 },
      }),
    );
    expect(normalized.traits).toEqual({ tier: "gold", lifetime_value: 4200 });
    expect(normalized.traits_version).toBe(7);
  });

  it("hashes a trait email on the same toggle as an identity email", () => {
    // A vendor receiving hashed email in its identity block must not
    // receive the plaintext of the same address one field over.
    const normalized = normalize(
      buildEnvelope({ profile: { ...PROFILE, traits: { email: "someone@example.com" } } }),
    );
    expect(normalized.traits?.["email"]).toBeUndefined();
    expect(normalized.traits?.["email_sha256"]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("drops an unhashable phone trait rather than passing it through raw", () => {
    // Traits are a convenience surface. Leaking a plaintext phone because
    // it was badly formatted is not a trade-off worth making; the raw value
    // is still on `identity.phone` for a mapper that must re-attempt it.
    const normalized = normalize(
      buildEnvelope({ profile: { ...PROFILE, traits: { phone: "555 not e164" } } }),
    );
    expect(normalized.traits?.["phone"]).toBeUndefined();
    expect(normalized.traits?.["phone_sha256"]).toBeUndefined();
  });

  it("leaves a trait email alone when the destination disables email hashing", () => {
    const outcome = normalizeForDestination(
      buildEnvelope({ profile: { ...PROFILE, traits: { email: "someone@example.com" } } }),
      {
        destinationId: "polaris_dst_test",
        requiredConsent: {},
        identityHashing: { email: false },
      },
    );
    if (outcome.kind !== "normalized") throw new Error("unexpected drop");
    expect(outcome.normalized.traits?.["email"]).toBe("someone@example.com");
  });

  it("does not mutate the envelope's traits object", () => {
    const traits = { email: "someone@example.com", tier: "gold" };
    normalize(buildEnvelope({ profile: { ...PROFILE, traits } }));
    expect(traits.email).toBe("someone@example.com");
  });

  it("reports null traits and a null version rather than an empty object", () => {
    // `traits: null` covers both "no traits" and "snapshot over the size
    // guard" by design, and a mapper must be able to tell that from "{}".
    const normalized = normalize(buildEnvelope({ profile: { ...PROFILE, traits: null } }));
    expect(normalized.traits).toBeNull();
    expect(normalized.traits_version).toBeNull();
  });
});

describe("traits and the redaction policy", () => {
  it("redacts a forbidden field inside traits, exactly as inside properties", () => {
    // The claim worth pinning: traits reach the vendor through the same
    // boundary as producer properties and carry the same class of data, so
    // their different PROVENANCE — the profile store rather than the
    // producer — must not buy them a weaker rule. The policy evaluator
    // walks the whole envelope from the root, which is what makes this
    // true; a future change scoping it to `properties` would open a hole in
    // the policy by way of a different table, and this test is what fails.
    const normalized = normalize(
      buildEnvelope({
        profile: { ...PROFILE, traits: { card_number: "4111111111111111", tier: "gold" } },
        properties: { card_number: "4111111111111111" },
      }),
    );
    expect(normalized.properties["card_number"]).toMatch(/^\[REDACTED:/);
    expect(normalized.traits?.["card_number"]).toMatch(/^\[REDACTED:/);
    expect(normalized.traits?.["tier"]).toBe("gold");
  });
});

describe("enrichment", () => {
  it("exposes geo so a mapper need not re-derive it from a redacted IP", () => {
    const normalized = normalize(
      buildEnvelope({
        enrichment: { geo: { country: "BR", region: "SP", city: "São Paulo", source: "maxmind" } },
      }),
    );
    expect(normalized.enrichment.geo).toEqual({
      country: "BR",
      region: "SP",
      city: "São Paulo",
      source: "maxmind",
    });
  });

  it("distinguishes a lookup that found nothing from one that never ran", () => {
    const attempted = normalize(
      buildEnvelope({
        enrichment: { geo: { country: null, region: null, city: null, source: "no_ip" } },
      }),
    );
    expect(attempted.enrichment.geo?.source).toBe("no_ip");

    const unenriched = normalize(buildEnvelope());
    expect(unenriched.enrichment.geo).toBeNull();
  });
});
