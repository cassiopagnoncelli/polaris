import { describe, expect, it } from "vitest";

import { AUTH_PROBLEM_CODES } from "../../src/auth/errors.js";
import { createAuthService } from "../../src/auth/service.js";
import { InMemoryApiKeyRepository } from "../fixtures.js";

function seedActive(
  repo: InMemoryApiKeyRepository,
  overrides?: Partial<{
    apiKeyId: string;
    hash: string;
    hashAlgorithm: string;
    status: string;
  }>,
) {
  repo.set({
    apiKeyId: overrides?.apiKeyId ?? "ak_test",
    projectId: "checkout",
    environment: "production",
    sourceId: "storefront-web",
    sourceType: "web",
    hash: overrides?.hash ?? "argon2id-stub-hash",
    hashAlgorithm: overrides?.hashAlgorithm ?? "argon2id",
    status: overrides?.status ?? "active",
  });
}

async function alwaysTrueVerify(): Promise<boolean> {
  return true;
}

async function alwaysFalseVerify(): Promise<boolean> {
  return false;
}

describe("createAuthService", () => {
  it("rejects a missing header with missing_api_key", async () => {
    const repo = new InMemoryApiKeyRepository();
    const auth = createAuthService({ repository: repo, verifyHash: alwaysTrueVerify });
    const result = await auth(undefined);
    expect(result).toMatchObject({
      ok: false,
      reason: "missing_header",
      problemCode: AUTH_PROBLEM_CODES.missingApiKey,
    });
    // The repository must not be queried before we even know what to look up.
    expect(repo.lookupCount).toBe(0);
  });

  it("rejects a malformed header with invalid_api_key", async () => {
    const repo = new InMemoryApiKeyRepository();
    const auth = createAuthService({ repository: repo, verifyHash: alwaysTrueVerify });
    const result = await auth("no-separator");
    expect(result).toMatchObject({
      ok: false,
      reason: "malformed_header",
      problemCode: AUTH_PROBLEM_CODES.invalidApiKey,
    });
    expect(repo.lookupCount).toBe(0);
  });

  it("rejects an unknown api_key_id with invalid_api_key", async () => {
    const repo = new InMemoryApiKeyRepository();
    const auth = createAuthService({ repository: repo, verifyHash: alwaysTrueVerify });
    const result = await auth("ak_missing.secret");
    expect(result).toMatchObject({
      ok: false,
      reason: "unknown_key",
      problemCode: AUTH_PROBLEM_CODES.invalidApiKey,
      apiKeyId: "ak_missing",
    });
  });

  it("rejects a revoked key with invalid_api_key", async () => {
    const repo = new InMemoryApiKeyRepository();
    seedActive(repo, { status: "revoked" });
    const auth = createAuthService({ repository: repo, verifyHash: alwaysTrueVerify });
    const result = await auth("ak_test.secret");
    expect(result).toMatchObject({
      ok: false,
      reason: "revoked_key",
      problemCode: AUTH_PROBLEM_CODES.invalidApiKey,
    });
  });

  it("rejects an unsupported algorithm with invalid_api_key", async () => {
    const repo = new InMemoryApiKeyRepository();
    seedActive(repo, { hashAlgorithm: "bcrypt" });
    const auth = createAuthService({ repository: repo, verifyHash: alwaysTrueVerify });
    const result = await auth("ak_test.secret");
    expect(result).toMatchObject({
      ok: false,
      reason: "unsupported_algorithm",
      problemCode: AUTH_PROBLEM_CODES.invalidApiKey,
    });
  });

  it("rejects a hash mismatch with invalid_api_key", async () => {
    const repo = new InMemoryApiKeyRepository();
    seedActive(repo);
    const auth = createAuthService({ repository: repo, verifyHash: alwaysFalseVerify });
    const result = await auth("ak_test.wrong");
    expect(result).toMatchObject({
      ok: false,
      reason: "hash_mismatch",
      problemCode: AUTH_PROBLEM_CODES.invalidApiKey,
    });
  });

  it("accepts a valid header and resolves the trusted tuple", async () => {
    const repo = new InMemoryApiKeyRepository();
    seedActive(repo);
    const auth = createAuthService({ repository: repo, verifyHash: alwaysTrueVerify });
    const result = await auth("ak_test.right");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context).toEqual({
      apiKeyId: "ak_test",
      projectId: "checkout",
      environment: "production",
      source: { id: "storefront-web", type: "web" },
    });
  });

  it("does not leak the secret into the rejection result", async () => {
    const repo = new InMemoryApiKeyRepository();
    const auth = createAuthService({ repository: repo, verifyHash: alwaysFalseVerify });
    const result = await auth("ak_test.SECRET-TAIL");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("SECRET-TAIL");
  });
});
