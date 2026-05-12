import { hash } from "@node-rs/argon2";
import { describe, expect, it } from "vitest";

import { verifyApiKeyHash } from "../../src/auth/hash.js";

// argon2 is intentionally slow. The default cost parameters compute in
// ~30-80ms per call on modern hardware; we run a tiny number of cases here.

describe("verifyApiKeyHash", () => {
  it("verifies a matching argon2id hash", async () => {
    const plaintext = "super-secret-tail-7c8a";
    const stored = await hash(plaintext);
    await expect(verifyApiKeyHash(plaintext, stored, "argon2id")).resolves.toBe(true);
  }, 10_000);

  it("rejects a non-matching secret", async () => {
    const stored = await hash("right-secret");
    await expect(verifyApiKeyHash("wrong-secret", stored, "argon2id")).resolves.toBe(false);
  }, 10_000);

  it("rejects any non-argon2id algorithm without calling the verifier", async () => {
    await expect(verifyApiKeyHash("anything", "doesnt-matter", "bcrypt")).resolves.toBe(false);
  });

  it("returns false on malformed hash input rather than throwing", async () => {
    await expect(verifyApiKeyHash("anything", "not-a-phc-string", "argon2id")).resolves.toBe(false);
  });
});
