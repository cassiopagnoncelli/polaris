import { describe, expect, it } from "vitest";

import {
  hashEmailLower,
  hashPhoneE164,
  pickBestIdentity,
  prepareIdentity,
  sha256Hex,
} from "../src/index.js";

describe("prepareIdentity", () => {
  it("hashes email and phone by default", () => {
    const identity = prepareIdentity({
      user_id: "cus_001",
      email: "ALICE@Example.COM",
      phone: "+15555550123",
    });
    expect(identity.user_id).toBe("cus_001");
    expect(identity.email_sha256).toBe(hashEmailLower("alice@example.com"));
    expect(identity.phone_sha256).toBe(hashPhoneE164("+15555550123"));
  });

  it("empties the plaintext slot once the digest exists", () => {
    // One slot per match key, never both. `webhook-sink` hands the whole
    // prepared identity to its receiver, so a populated raw slot beside a
    // digest is a delivery of the plaintext the destination asked to have
    // hashed — the same hole the trait bag is hashed to close, one field
    // over.
    const identity = prepareIdentity({ email: "ALICE@Example.COM", phone: "+15555550123" });
    expect(identity.email).toBeNull();
    expect(identity.phone).toBeNull();
  });

  it("respects `hashing.email = false`", () => {
    const identity = prepareIdentity({ email: "alice@example.com" }, { email: false });
    expect(identity.email).toBe("alice@example.com");
    expect(identity.email_sha256).toBeNull();
  });

  it("respects `hashing.phone = false`", () => {
    const identity = prepareIdentity({ phone: "+15555550123" }, { phone: false });
    expect(identity.phone).toBe("+15555550123");
    expect(identity.phone_sha256).toBeNull();
  });

  it("preserves the trimmed phone but leaves phone_sha256 null on non-E.164 input", () => {
    // The base layer refuses to invent a country code — see phone.ts.
    // Identity preparation must surface that decision without throwing,
    // so a consumer-specific normalize stage can attempt a reformat.
    const identity = prepareIdentity({ phone: "(415) 555-0123" });
    expect(identity.phone).toBe("(415) 555-0123");
    expect(identity.phone_sha256).toBeNull();
  });

  it("treats null / empty / whitespace identity fields as missing", () => {
    const identity = prepareIdentity({
      user_id: "",
      anonymous_id: null,
      email: "   ",
      phone: undefined,
    });
    expect(identity.user_id).toBeNull();
    expect(identity.anonymous_id).toBeNull();
    expect(identity.email).toBeNull();
    expect(identity.email_sha256).toBeNull();
    expect(identity.phone).toBeNull();
    expect(identity.phone_sha256).toBeNull();
  });
});

describe("pickBestIdentity priority", () => {
  it("prefers user_id over email_sha256, phone_sha256, anonymous_id", () => {
    const identity = prepareIdentity({
      user_id: "cus_001",
      anonymous_id: "anon_xyz",
      email: "alice@example.com",
      phone: "+15555550123",
    });
    expect(pickBestIdentity(identity)).toEqual({
      kind: "user_id",
      value: "cus_001",
    });
  });

  it("prefers email_sha256 when user_id is absent", () => {
    const identity = prepareIdentity({
      anonymous_id: "anon_xyz",
      email: "alice@example.com",
      phone: "+15555550123",
    });
    const best = pickBestIdentity(identity);
    expect(best?.kind).toBe("email_sha256");
    expect(best?.value).toBe(hashEmailLower("alice@example.com"));
  });

  it("prefers phone_sha256 when user_id and email are absent", () => {
    const identity = prepareIdentity({
      anonymous_id: "anon_xyz",
      phone: "+15555550123",
    });
    const best = pickBestIdentity(identity);
    expect(best?.kind).toBe("phone_sha256");
    expect(best?.value).toBe(hashPhoneE164("+15555550123"));
  });

  it("falls back to anonymous_id when nothing else is usable", () => {
    const identity = prepareIdentity({ anonymous_id: "anon_xyz" });
    expect(pickBestIdentity(identity)).toEqual({
      kind: "anonymous_id",
      value: "anon_xyz",
    });
  });

  it("returns undefined when no identity is usable", () => {
    const identity = prepareIdentity({});
    expect(pickBestIdentity(identity)).toBeUndefined();
  });

  it("treats a non-E.164 phone (no hash) as no-phone for ranking", () => {
    const identity = prepareIdentity({
      anonymous_id: "anon_xyz",
      phone: "(415) 555-0123",
    });
    // phone_sha256 is null, so anonymous_id wins.
    expect(pickBestIdentity(identity)?.kind).toBe("anonymous_id");
  });
});

describe("prepareIdentity: the extended match set", () => {
  const PERSON = {
    first_name: "John",
    last_name: "Smith",
    gender: "male",
    birthday: "1990-02-15",
  } as const;
  const ADDRESS = {
    city: "Menlo Park",
    state: "CA",
    postal_code: "94025-1234",
    country: "United States",
  } as const;

  it("hashes each key over its own canonical form", () => {
    const identity = prepareIdentity({ ...PERSON, ...ADDRESS });
    expect(identity.first_name_sha256).toBe(sha256Hex("john"));
    expect(identity.last_name_sha256).toBe(sha256Hex("smith"));
    expect(identity.gender_sha256).toBe(sha256Hex("m"));
    expect(identity.birthday_sha256).toBe(sha256Hex("19900215"));
    expect(identity.city_sha256).toBe(sha256Hex("menlopark"));
    expect(identity.state_sha256).toBe(sha256Hex("ca"));
    expect(identity.postal_code_sha256).toBe(sha256Hex("94025"));
    expect(identity.country_sha256).toBe(sha256Hex("us"));
  });

  it("leaves the plaintext slot empty when the destination takes hashes", () => {
    // The invariant, made structural: a destination that receives a
    // hashed first name must not find the plaintext one beside it. Email
    // keeps its raw slot because a consumer-specific normalize may
    // re-canonicalize it; these eight have no such re-attempt path.
    const identity = prepareIdentity({ ...PERSON, ...ADDRESS });
    expect(identity.first_name).toBeNull();
    expect(identity.city).toBeNull();
    expect(identity.country).toBeNull();
  });

  it("gives the canonical value instead of the digest when hashing is off", () => {
    // Braze's stance: the vendor hashes server-side, so it takes plaintext.
    const identity = prepareIdentity({ ...PERSON, ...ADDRESS }, { email: false, phone: false });
    expect(identity.first_name).toBe("john");
    expect(identity.gender).toBe("m");
    expect(identity.birthday).toBe("19900215");
    expect(identity.country).toBe("us");
    expect(identity.first_name_sha256).toBeNull();
    expect(identity.country_sha256).toBeNull();
  });

  it("follows the email toggle, which is the destination's stance on hashed PII", () => {
    const identity = prepareIdentity({ ...PERSON }, { email: false });
    expect(identity.first_name).toBe("john");
    expect(identity.first_name_sha256).toBeNull();
  });

  it("leaves both slots null when the source is absent", () => {
    const identity = prepareIdentity({ user_id: "cus_001" });
    expect(identity.first_name).toBeNull();
    expect(identity.first_name_sha256).toBeNull();
    expect(identity.country).toBeNull();
    expect(identity.country_sha256).toBeNull();
  });

  it("leaves both slots null when the rule refuses the value", () => {
    const identity = prepareIdentity({
      gender: "non-binary",
      birthday: "1990-02-30",
      country: "Narnia",
    });
    expect(identity.gender_sha256).toBeNull();
    expect(identity.birthday_sha256).toBeNull();
    expect(identity.country_sha256).toBeNull();
  });

  it("does not move the best-identity chain", () => {
    // `pickBestIdentity` order is unchanged by this set: a hashed city is
    // not an identifier, and treating one as a fallback would key a vendor
    // on everyone who lives in the same town.
    const identity = prepareIdentity({ anonymous_id: "anon_xyz", ...ADDRESS });
    expect(pickBestIdentity(identity)?.kind).toBe("anonymous_id");
  });
});
