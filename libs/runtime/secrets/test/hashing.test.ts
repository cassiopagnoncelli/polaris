/**
 * Tests for the shared argon2id hashing primitive.
 *
 * The primitive is the workspace's only sanctioned hashing path: both the
 * ingester (`apps/ingester-api/src/auth/hash.ts`) and the polaris CLI
 * lifecycle commands (`apps/polaris-cli/src/commands/keys/*`) consume it. A
 * round-trip test through `hashSecret` -> `verifySecret` proves both call
 * sites can speak the same wire/storage format.
 */
import { describe, expect, it } from "vitest";

import { hashSecret, POLARIS_HASH_ALGORITHM, verifySecret } from "../src/hashing.js";

describe("POLARIS_HASH_ALGORITHM", () => {
  it("is the literal argon2id string both the ingester and CLI persist", () => {
    expect(POLARIS_HASH_ALGORITHM).toBe("argon2id");
  });
});

describe("hashSecret / verifySecret round-trip", () => {
  it("hashSecret produces a value that verifySecret accepts", async () => {
    const plaintext = "super-secret-tail-abc123";
    const stored = await hashSecret(plaintext);
    await expect(verifySecret(plaintext, stored, POLARIS_HASH_ALGORITHM)).resolves.toBe(true);
  }, 10_000);

  it("verifySecret rejects a non-matching plaintext", async () => {
    const stored = await hashSecret("right-secret");
    await expect(verifySecret("wrong-secret", stored, POLARIS_HASH_ALGORITHM)).resolves.toBe(false);
  }, 10_000);

  it("hashSecret produces a PHC-prefixed argon2id string", async () => {
    const stored = await hashSecret("any-secret");
    // The `@node-rs/argon2` library emits canonical PHC: `$argon2id$v=...$...`.
    // We assert the prefix so both call sites can rely on a stable on-disk
    // shape (used by `api_keys.hash_algorithm = 'argon2id'` rows).
    expect(stored.startsWith("$argon2id$")).toBe(true);
  }, 10_000);

  it("hashSecret produces a different hash on every call (salted)", async () => {
    const plaintext = "same-input-different-salt";
    const a = await hashSecret(plaintext);
    const b = await hashSecret(plaintext);
    // argon2id mixes a random per-call salt into the output, so two hashes of
    // the same plaintext must differ. If they ever match, the salting layer
    // is broken or the library lost its RNG.
    expect(a).not.toBe(b);
    // Both must still verify against the original plaintext.
    await expect(verifySecret(plaintext, a, POLARIS_HASH_ALGORITHM)).resolves.toBe(true);
    await expect(verifySecret(plaintext, b, POLARIS_HASH_ALGORITHM)).resolves.toBe(true);
  }, 15_000);

  it("hashSecret rejects empty plaintext", async () => {
    await expect(hashSecret("")).rejects.toBeInstanceOf(TypeError);
  });
});

describe("verifySecret", () => {
  it("rejects any non-argon2id algorithm without calling the verifier", async () => {
    await expect(verifySecret("anything", "doesnt-matter", "bcrypt")).resolves.toBe(false);
  });

  it("returns false on malformed PHC input rather than throwing", async () => {
    await expect(verifySecret("anything", "not-a-phc-string", "argon2id")).resolves.toBe(false);
  });
});
