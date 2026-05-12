import { describe, expect, it } from "vitest";

import { hashEmailLower, hashPhoneE164, pickBestIdentity, prepareIdentity } from "../src/index.js";

describe("prepareIdentity", () => {
  it("hashes email and phone by default", () => {
    const identity = prepareIdentity({
      user_id: "cus_001",
      email: "ALICE@Example.COM",
      phone: "+15555550123",
    });
    expect(identity.user_id).toBe("cus_001");
    expect(identity.email).toBe("ALICE@Example.COM");
    expect(identity.email_sha256).toBe(hashEmailLower("alice@example.com"));
    expect(identity.phone_sha256).toBe(hashPhoneE164("+15555550123"));
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
