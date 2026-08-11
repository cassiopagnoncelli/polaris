/**
 * Identity-cookie tests.
 *
 * This cookie carries the email that becomes `audit_records.actor_label`. If
 * it can be forged, an operator can attribute their own mutations to someone
 * else — so tampering, cross-secret reuse, and subject mismatch all have to
 * fail closed.
 */

import { describe, expect, it } from "vitest";

import { AdminIdentityCodec, bindIdentity } from "../src/admin/identity.js";

const SECRET = "a".repeat(48);
const OTHER_SECRET = "b".repeat(48);

const IDENTITY = {
  sub: "usr_0196000000000000",
  email: "ops@example.com",
  name: "Ops Person",
  idToken: "eyJhbGciOiJFUzI1NiJ9.payload.sig",
} as const;

describe("AdminIdentityCodec", () => {
  it("round-trips an identity", () => {
    const codec = new AdminIdentityCodec(SECRET);
    expect(codec.decode(codec.encode(IDENTITY))).toEqual(IDENTITY);
  });

  it("refuses a tampered payload", () => {
    const codec = new AdminIdentityCodec(SECRET);
    const [version, , signature] = codec.encode(IDENTITY).split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...IDENTITY, email: "attacker@example.com" }),
      "utf8",
    ).toString("base64url");
    expect(codec.decode(`${version}.${forged}.${signature}`)).toBeNull();
  });

  it("refuses a tampered signature", () => {
    const codec = new AdminIdentityCodec(SECRET);
    const [version, payload] = codec.encode(IDENTITY).split(".");
    expect(codec.decode(`${version}.${payload}.notasignature`)).toBeNull();
  });

  it("refuses a cookie signed with a different secret", () => {
    const encoded = new AdminIdentityCodec(OTHER_SECRET).encode(IDENTITY);
    expect(new AdminIdentityCodec(SECRET).decode(encoded)).toBeNull();
  });

  it("refuses malformed input without throwing", () => {
    const codec = new AdminIdentityCodec(SECRET);
    for (const value of [undefined, "", "one", "one.two", "a.b.c.d", "v1..sig", "v9.x.y"]) {
      expect(codec.decode(value)).toBeNull();
    }
  });

  it("refuses a correctly signed cookie with no subject", () => {
    const codec = new AdminIdentityCodec(SECRET);
    const encoded = codec.encode({ sub: "", email: null, name: null, idToken: null });
    expect(codec.decode(encoded)).toBeNull();
  });

  it("tolerates absent optional claims", () => {
    const codec = new AdminIdentityCodec(SECRET);
    const minimal = { sub: "usr_1", email: null, name: null, idToken: null };
    expect(codec.decode(codec.encode(minimal))).toEqual(minimal);
  });
});

describe("bindIdentity", () => {
  it("accepts an identity for the same subject", () => {
    expect(bindIdentity(IDENTITY, IDENTITY.sub)).toEqual(IDENTITY);
  });

  it("drops a validly signed identity describing someone else", () => {
    // The signature proves *we* issued it, not that it belongs to the
    // passport presenting it. Without this check a stale cookie kept across a
    // re-login as a different user would mis-attribute every audit row.
    expect(bindIdentity(IDENTITY, "usr_someone_else")).toBeNull();
  });

  it("passes null through", () => {
    expect(bindIdentity(null, IDENTITY.sub)).toBeNull();
  });
});
