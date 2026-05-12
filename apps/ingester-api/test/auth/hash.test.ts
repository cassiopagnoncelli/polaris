import { hashSecret } from "@polaris/shared-secrets";
import { describe, expect, it } from "vitest";

import { verifyApiKeyHash } from "../../src/auth/hash.js";

// argon2 is intentionally slow. The default cost parameters compute in
// ~30-80ms per call on modern hardware; we run a tiny number of cases here.
//
// The hash primitive is owned by `@polaris/shared-secrets`. We import
// `hashSecret` from there so the test exercises the actual issuance path
// the lifecycle CLI uses, and assert it round-trips through the ingester's
// `verifyApiKeyHash`.

describe("verifyApiKeyHash", () => {
  it("verifies a matching argon2id hash", async () => {
    const plaintext = "super-secret-tail-7c8a";
    const stored = await hashSecret(plaintext);
    await expect(verifyApiKeyHash(plaintext, stored, "argon2id")).resolves.toBe(true);
  }, 10_000);

  it("rejects a non-matching secret", async () => {
    const stored = await hashSecret("right-secret");
    await expect(verifyApiKeyHash("wrong-secret", stored, "argon2id")).resolves.toBe(false);
  }, 10_000);

  it("rejects any non-argon2id algorithm without calling the verifier", async () => {
    await expect(verifyApiKeyHash("anything", "doesnt-matter", "bcrypt")).resolves.toBe(false);
  });

  it("returns false on malformed hash input rather than throwing", async () => {
    await expect(verifyApiKeyHash("anything", "not-a-phc-string", "argon2id")).resolves.toBe(false);
  });
});
