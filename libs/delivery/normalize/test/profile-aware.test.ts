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

import {
  normalizeForDestination,
  pickBestIdentity,
  prepareIdentity,
  sha256Hex,
} from "../src/index.js";

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

/**
 * The defect this card exists to close.
 *
 * In production Meta and TikTok never received a hashed email or phone.
 * The mappers emit `em` / `ph` from `identity.email_sha256`; identity
 * preparation filled that only from a connector's optional
 * `identityFromProperties` hook, which only Braze declares; and nothing
 * read the trait snapshot that enrichment stamps on every resolved event
 * of a known person. Two correct halves with nothing joining them, and no
 * test in between: the mapper goldens start from a pre-hashed fixture, so
 * they were green throughout.
 *
 * `META_LIKE` is a vendor descriptor's normalize options as Meta and
 * TikTok declare them — hash everything, no properties hook. Spelled out
 * here rather than imported, because a library test that reaches into a
 * connector inverts the dependency the connector layer exists to keep.
 */
const META_LIKE = {
  destinationId: "polaris_dst_test",
  requiredConsent: {},
  identityHashing: { email: true, phone: true },
} as const;

function normalizeAsMeta(envelope: Parameters<typeof normalizeForDestination>[0]) {
  const outcome = normalizeForDestination(envelope, META_LIKE);
  if (outcome.kind !== "normalized") throw new Error(`unexpected drop: ${outcome.reason}`);
  return outcome.normalized;
}

describe("identity from the profile-trait snapshot", () => {
  it("hashes an email that arrived only in profile traits, for a destination with no properties hook", () => {
    const normalized = normalizeAsMeta(
      buildEnvelope({
        properties: { amount: 12990, currency: "BRL" },
        profile: { ...PROFILE, traits: { email: "someone@example.com" } },
      }),
    );
    expect(normalized.identity.email_sha256).toBe(sha256Hex("someone@example.com"));
  });

  it("hashes a phone that arrived only in profile traits, for a destination with no properties hook", () => {
    const normalized = normalizeAsMeta(
      buildEnvelope({ profile: { ...PROFILE, traits: { phone: "+15555550123" } } }),
    );
    expect(normalized.identity.phone_sha256).toBe(sha256Hex("+15555550123"));
  });

  it("fills the whole match set from the pinned trait slots", () => {
    const normalized = normalizeAsMeta(
      buildEnvelope({
        profile: {
          ...PROFILE,
          traits: {
            first_name: "John",
            last_name: "Smith",
            gender: "male",
            birthday: "1990-02-15",
            address: {
              street: "1 Hacker Way",
              city: "Menlo Park",
              state: "CA",
              postal_code: "94025-1234",
              country: "United States",
            },
          },
        },
      }),
    );
    expect(normalized.identity.first_name_sha256).toBe(sha256Hex("john"));
    expect(normalized.identity.last_name_sha256).toBe(sha256Hex("smith"));
    expect(normalized.identity.gender_sha256).toBe(sha256Hex("m"));
    expect(normalized.identity.birthday_sha256).toBe(sha256Hex("19900215"));
    expect(normalized.identity.city_sha256).toBe(sha256Hex("menlopark"));
    expect(normalized.identity.state_sha256).toBe(sha256Hex("ca"));
    expect(normalized.identity.postal_code_sha256).toBe(sha256Hex("94025"));
    expect(normalized.identity.country_sha256).toBe(sha256Hex("us"));
  });

  it("leaves the match set empty on an envelope that never reached the spine", () => {
    // No profile block at all: `analytics.events` traffic and every replay
    // of history. Nothing to fall back to, and no drop caused by looking.
    const normalized = normalizeAsMeta(buildEnvelope());
    expect(normalized.identity.email_sha256).toBeNull();
    expect(normalized.identity.first_name_sha256).toBeNull();
  });
});

describe("identity precedence: properties over the trait snapshot", () => {
  const envelope = buildEnvelope({
    properties: { email: "newest@example.com", amount: 1 },
    profile: { ...PROFILE, traits: { email: "snapshot@example.com" } },
  });

  it("prefers a producer property over the trait snapshot", () => {
    // The snapshot was taken when the event was enriched; the property is
    // on the event itself, and this event may be what changes the profile.
    const outcome = normalizeForDestination(envelope, {
      ...META_LIKE,
      identityFromProperties: (props) => ({ email: props["email"] as string }),
    });
    if (outcome.kind !== "normalized") throw new Error("unexpected drop");
    expect(outcome.normalized.identity.email_sha256).toBe(sha256Hex("newest@example.com"));
  });

  it("falls to the snapshot for a field the hook did not return", () => {
    // A hook that found a phone and no email must not blank the email the
    // snapshot had: precedence is not deletion.
    const outcome = normalizeForDestination(
      buildEnvelope({
        properties: { phone: "+15555550123" },
        profile: { ...PROFILE, traits: { email: "snapshot@example.com" } },
      }),
      {
        ...META_LIKE,
        identityFromProperties: (props) => ({ phone: props["phone"] as string }),
      },
    );
    if (outcome.kind !== "normalized") throw new Error("unexpected drop");
    expect(outcome.normalized.identity.email_sha256).toBe(sha256Hex("snapshot@example.com"));
    expect(outcome.normalized.identity.phone_sha256).toBe(sha256Hex("+15555550123"));
  });

  it("falls to the snapshot when the destination declares no hook at all", () => {
    const normalized = normalizeAsMeta(envelope);
    expect(normalized.identity.email_sha256).toBe(sha256Hex("snapshot@example.com"));
  });
});

describe("traits: the extended match set in the bag it arrived in", () => {
  function normalizeTraitsOf(traits: Record<string, unknown>) {
    return normalizeAsMeta(buildEnvelope({ profile: { ...PROFILE, traits } })).traits;
  }

  it("hashes the person keys in place", () => {
    const traits = normalizeTraitsOf({ first_name: "John", gender: "male", tier: "gold" });
    expect(traits?.["first_name"]).toBeUndefined();
    expect(traits?.["first_name_sha256"]).toBe(sha256Hex("john"));
    expect(traits?.["gender_sha256"]).toBe(sha256Hex("m"));
    expect(traits?.["tier"]).toBe("gold");
  });

  it("hashes the address keys inside the address bag, leaving its shape alone", () => {
    // A receiver reading `traits.address` finds the same object with
    // hashed leaves, not a flattened one — and `street`, which no vendor
    // matches on, is untouched.
    const traits = normalizeTraitsOf({
      address: { street: "1 Hacker Way", city: "Menlo Park", country: "United States" },
    });
    const address = traits?.["address"] as Record<string, unknown>;
    expect(address["city"]).toBeUndefined();
    expect(address["city_sha256"]).toBe(sha256Hex("menlopark"));
    expect(address["country_sha256"]).toBe(sha256Hex("us"));
    expect(address["street"]).toBe("1 Hacker Way");
  });

  it("drops a value its rule refuses rather than passing it through raw", () => {
    // The conservative branch the phone trait already had, now for every
    // key: an unresolvable country is not sent in the clear because it
    // could not be hashed.
    const traits = normalizeTraitsOf({
      gender: "prefer not to say",
      address: { country: "Narnia", city: "Menlo Park" },
    });
    expect(traits?.["gender"]).toBeUndefined();
    expect(traits?.["gender_sha256"]).toBeUndefined();
    const address = traits?.["address"] as Record<string, unknown>;
    expect(address["country"]).toBeUndefined();
    expect(address["country_sha256"]).toBeUndefined();
  });

  it("leaves the whole set in the clear when the destination takes plaintext", () => {
    // Braze. The identity block carries the canonical form and the bag
    // keeps the producer's spelling, which is the one a messaging vendor
    // renders into a template.
    const outcome = normalizeForDestination(
      buildEnvelope({
        profile: {
          ...PROFILE,
          traits: { first_name: "John", address: { city: "Menlo Park" } },
        },
      }),
      {
        destinationId: "polaris_dst_test",
        requiredConsent: {},
        identityHashing: { email: false, phone: false },
      },
    );
    if (outcome.kind !== "normalized") throw new Error("unexpected drop");
    expect(outcome.normalized.traits?.["first_name"]).toBe("John");
    expect((outcome.normalized.traits?.["address"] as Record<string, unknown>)["city"]).toBe(
      "Menlo Park",
    );
    expect(outcome.normalized.identity.first_name).toBe("john");
  });

  it("does not mutate the envelope's address bag", () => {
    const address = { city: "Menlo Park", country: "United States" };
    normalizeAsMeta(buildEnvelope({ profile: { ...PROFILE, traits: { address } } }));
    expect(address.city).toBe("Menlo Park");
    expect(address.country).toBe("United States");
  });
});
