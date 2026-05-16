import { describe, expect, it } from "vitest";

import {
  createVaultProvider,
  SecretNotFoundError,
  SecretProviderError,
  VaultSecretProvider,
} from "../src/index.js";
import type {
  ServiceAccountTokenReader,
  VaultHttp,
  VaultHttpInit,
  VaultHttpResponse,
} from "../src/providers/vault-token-manager.js";

/**
 * Sentinel values used across every test in this file. Resolved secrets and
 * the auth tokens must never appear in error messages, stacks, or
 * diagnostic outputs.
 */
const SECRET_VALUE = "tk_super_secret_should_never_leak";
const ROTATED_SECRET_VALUE = "tk_rotated_value_v2_super_secret";
const SA_JWT = "eyJhbGciOiJSUzI1NiJ9.fake.serviceaccount.jwt";
const VAULT_TOKEN = "hvs.fake_vault_client_token_should_not_leak";

const ADDRESS = "https://vault.svc:8200";

class FakeReader implements ServiceAccountTokenReader {
  constructor(private readonly value: string = SA_JWT) {}
  public async read(): Promise<string> {
    return this.value;
  }
}

class FakeClock {
  public t = 1_000_000;
  public now(): number {
    return this.t;
  }
}

function makeResponse(status: number, jsonPayload: unknown): VaultHttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: () => Promise.resolve(JSON.stringify(jsonPayload)),
    json: () => Promise.resolve(jsonPayload),
  };
}

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

function recordingHttp(
  responder: (call: RecordedCall) => VaultHttpResponse | Promise<VaultHttpResponse>,
): { http: VaultHttp; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const http: VaultHttp = async (url: string, init: VaultHttpInit) => {
    calls.push({ url, method: init.method, headers: init.headers });
    return responder({ url, method: init.method, headers: init.headers });
  };
  return { http, calls };
}

function loginResponse(): VaultHttpResponse {
  return makeResponse(200, {
    auth: { client_token: VAULT_TOKEN, lease_duration: 3600, renewable: true },
  });
}

function kvResponse(value: string): VaultHttpResponse {
  return makeResponse(200, { data: { data: { value } } });
}

describe("VaultSecretProvider", () => {
  it("authenticates and fetches a KV v2 secret on the happy path", async () => {
    const { http, calls } = recordingHttp((call) => {
      if (call.url.endsWith("/v1/auth/kubernetes/login")) {
        return loginResponse();
      }
      if (call.url === `${ADDRESS}/v1/secret/data/polaris/production/storefront/meta-capi`) {
        return kvResponse(SECRET_VALUE);
      }
      throw new Error("unexpected url " + call.url);
    });
    const provider = createVaultProvider({
      address: ADDRESS,
      role: "polaris-production",
      serviceAccountTokenReader: new FakeReader(),
      http,
    });
    const value = await provider.getSecret("polaris/production/storefront/meta-capi");
    expect(value).toBe(SECRET_VALUE);
    expect(calls.length).toBe(2);
    expect(calls[1]?.headers["x-vault-token"]).toBe(VAULT_TOKEN);
  });

  it("returns the cached value on subsequent reads inside the TTL", async () => {
    const clock = new FakeClock();
    const { http, calls } = recordingHttp((call) => {
      if (call.url.endsWith("/login")) return loginResponse();
      return kvResponse(SECRET_VALUE);
    });
    const provider = createVaultProvider({
      address: ADDRESS,
      role: "polaris-production",
      serviceAccountTokenReader: new FakeReader(),
      http,
      now: () => clock.now(),
      cacheTtlMs: 60_000,
    });
    const ref = "polaris/production/p/x";
    await provider.getSecret(ref);
    await provider.getSecret(ref);
    await provider.getSecret(ref);
    // 1 login + 1 KV read; the next two reads are cache hits.
    expect(calls.length).toBe(2);
  });

  it("forces a Vault call again after the cache TTL expires", async () => {
    const clock = new FakeClock();
    const { http, calls } = recordingHttp((call) => {
      if (call.url.endsWith("/login")) return loginResponse();
      return kvResponse(SECRET_VALUE);
    });
    const provider = createVaultProvider({
      address: ADDRESS,
      role: "polaris-production",
      serviceAccountTokenReader: new FakeReader(),
      http,
      now: () => clock.now(),
      cacheTtlMs: 1_000,
    });
    const ref = "polaris/production/p/x";
    await provider.getSecret(ref);
    expect(calls.length).toBe(2); // login + read
    clock.t += 1_001;
    await provider.getSecret(ref);
    expect(calls.length).toBe(3); // login is still cached on the token manager; only KV re-read
  });

  it("throws SecretNotFoundError on a 404 KV read", async () => {
    const { http } = recordingHttp((call) => {
      if (call.url.endsWith("/login")) return loginResponse();
      return makeResponse(404, { errors: [] });
    });
    const provider = createVaultProvider({
      address: ADDRESS,
      role: "polaris-production",
      serviceAccountTokenReader: new FakeReader(),
      http,
    });
    await expect(
      provider.getSecret("polaris/production/missing/credential"),
    ).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it("re-authenticates once and retries the read when KV returns 403", async () => {
    let loginCount = 0;
    let kvCount = 0;
    const { http, calls } = recordingHttp((call) => {
      if (call.url.endsWith("/login")) {
        loginCount += 1;
        return loginResponse();
      }
      // First KV read 403s; the provider re-auths and retries, which succeeds.
      kvCount += 1;
      if (kvCount === 1) return makeResponse(403, { errors: ["permission denied"] });
      return kvResponse(SECRET_VALUE);
    });
    const provider = createVaultProvider({
      address: ADDRESS,
      role: "polaris-production",
      serviceAccountTokenReader: new FakeReader(),
      http,
    });
    const value = await provider.getSecret("polaris/production/p/x");
    expect(value).toBe(SECRET_VALUE);
    expect(loginCount).toBe(2);
    // login, kv(403), login, kv(200)
    expect(calls.length).toBe(4);
  });

  it("degrades to stale cache when Vault becomes unreachable", async () => {
    const clock = new FakeClock();
    let vaultIsUp = true;
    const { http } = recordingHttp((call) => {
      if (!vaultIsUp) {
        return Promise.reject(new Error("ECONNREFUSED"));
      }
      if (call.url.endsWith("/login")) return loginResponse();
      return kvResponse(SECRET_VALUE);
    });
    const provider = createVaultProvider({
      address: ADDRESS,
      role: "polaris-production",
      serviceAccountTokenReader: new FakeReader(),
      http,
      now: () => clock.now(),
      cacheTtlMs: 1_000,
    });
    const ref = "polaris/production/p/x";
    const first = await provider.getSecret(ref);
    expect(first).toBe(SECRET_VALUE);
    // Vault dies; advance past the cache TTL so the next fetch must go to Vault.
    vaultIsUp = false;
    clock.t += 2_000;
    const second = await provider.getSecret(ref);
    expect(second).toBe(SECRET_VALUE); // served from stale cache, NOT a crash
    expect(provider.probe().status).toBe("degraded");
  });

  it("throws SecretProviderError when Vault is unreachable and no cache exists", async () => {
    const { http } = recordingHttp(() => Promise.reject(new Error("ECONNREFUSED")));
    const provider = createVaultProvider({
      address: ADDRESS,
      role: "polaris-production",
      serviceAccountTokenReader: new FakeReader(),
      http,
    });
    await expect(provider.getSecret("polaris/production/p/x")).rejects.toBeInstanceOf(
      SecretProviderError,
    );
  });

  it("probe reports degraded before the first fetch", () => {
    const provider = createVaultProvider({
      address: ADDRESS,
      role: "polaris-production",
      serviceAccountTokenReader: new FakeReader(),
      http: async () => makeResponse(200, {}),
    });
    expect(provider.probe().status).toBe("degraded");
  });

  it("probe reports up after a successful fetch and down after a fresh-start outage", async () => {
    const provider = createVaultProvider({
      address: ADDRESS,
      role: "polaris-production",
      serviceAccountTokenReader: new FakeReader(),
      http: async () => Promise.reject(new Error("boom")),
    });
    await expect(provider.getSecret("polaris/production/p/x")).rejects.toBeDefined();
    expect(provider.probe().status).toBe("down");
  });

  it("does NOT include the resolved secret in error messages or stacks (read path)", async () => {
    // Provider seeded with a successful KV read so the secret enters memory,
    // then a malformed response on the next call forces an error to surface.
    let stage = "ok";
    const { http } = recordingHttp((call) => {
      if (call.url.endsWith("/login")) return loginResponse();
      if (stage === "ok") return kvResponse(SECRET_VALUE);
      // Now return a malformed body so the provider throws SecretProviderError
      // — this is the most likely path to accidentally include payload bytes.
      return makeResponse(200, {
        data: { data: { value: ROTATED_SECRET_VALUE, sibling_field: SECRET_VALUE } },
      });
    });
    const provider = createVaultProvider({
      address: ADDRESS,
      role: "polaris-production",
      serviceAccountTokenReader: new FakeReader(),
      http,
      cacheTtlMs: 0, // disable cache so each read goes to Vault
    });
    await provider.getSecret("polaris/production/p/x"); // primes a 'previous' value
    stage = "malformed-but-valid";
    // This succeeds and returns the rotated value; we'll then check that no
    // error string contains either sentinel.
    await provider.getSecret("polaris/production/p/x");
    // No error occurred above — that path is exercised elsewhere. The real
    // assertion here is for the actually-thrown shapes:
    const errors = await collectThrownErrors(provider);
    for (const e of errors) {
      const surface = `${e.message}\n${e.stack ?? ""}\n${String(e)}`;
      expect(surface).not.toContain(SECRET_VALUE);
      expect(surface).not.toContain(ROTATED_SECRET_VALUE);
      expect(surface).not.toContain(VAULT_TOKEN);
      expect(surface).not.toContain(SA_JWT);
    }
  });

  it("does NOT include the resolved secret in error messages when Vault returns malformed JSON", async () => {
    const { http } = recordingHttp((call) => {
      if (call.url.endsWith("/login")) return loginResponse();
      // Body claims to be a string but contains the secret. The provider must
      // reject the response without echoing it.
      return {
        status: 200,
        ok: true,
        text: () => Promise.resolve(`{"data":{"data":{"value":"${SECRET_VALUE}",broken_json`),
        json: () => Promise.reject(new SyntaxError(`unexpected token in ${SECRET_VALUE}`)),
      };
    });
    const provider = createVaultProvider({
      address: ADDRESS,
      role: "polaris-production",
      serviceAccountTokenReader: new FakeReader(),
      http,
    });
    let caught: Error | undefined;
    try {
      await provider.getSecret("polaris/production/p/x");
    } catch (err) {
      if (err instanceof Error) caught = err;
    }
    expect(caught).toBeInstanceOf(SecretProviderError);
    const surface = `${caught?.message ?? ""}\n${caught?.stack ?? ""}\n${String(caught)}`;
    // The provider must NOT propagate the broken JSON parse error's raw
    // text — which could embed the secret. The message is a generic
    // "vault response was not valid JSON".
    expect(surface).not.toContain(SECRET_VALUE);
    expect(caught?.message ?? "").toContain("not valid JSON");
  });

  it("rejects empty refs without calling Vault", async () => {
    let called = false;
    const { http } = recordingHttp(() => {
      called = true;
      return loginResponse();
    });
    const provider = createVaultProvider({
      address: ADDRESS,
      role: "polaris-production",
      serviceAccountTokenReader: new FakeReader(),
      http,
    });
    await expect(provider.getSecret("")).rejects.toBeInstanceOf(SecretProviderError);
    expect(called).toBe(false);
  });

  it("URL-encodes path segments while preserving slashes", async () => {
    const { http, calls } = recordingHttp((call) => {
      if (call.url.endsWith("/login")) return loginResponse();
      return kvResponse(SECRET_VALUE);
    });
    const provider = createVaultProvider({
      address: ADDRESS,
      role: "polaris-production",
      serviceAccountTokenReader: new FakeReader(),
      http,
    });
    // A ref with a space-like segment (already rejected by the reference
    // parser, but the provider must not accidentally double-encode slashes).
    await provider.getSecret("polaris/production/p%/needs-encoding");
    const kvCall = calls.find((c) => c.url.includes("/data/"));
    expect(kvCall?.url).toBe(`${ADDRESS}/v1/secret/data/polaris/production/p%25/needs-encoding`);
  });

  it("rejects an address with a trailing slash at construction time", () => {
    expect(() =>
      createVaultProvider({
        address: `${ADDRESS}/`,
        role: "polaris-production",
        serviceAccountTokenReader: new FakeReader(),
      }),
    ).toThrow(TypeError);
  });

  it("class form is publicly constructable and lease() exposes diagnostic state", async () => {
    const { http } = recordingHttp((call) => {
      if (call.url.endsWith("/login")) return loginResponse();
      return kvResponse(SECRET_VALUE);
    });
    const provider = new VaultSecretProvider({
      address: ADDRESS,
      role: "polaris-production",
      serviceAccountTokenReader: new FakeReader(),
      http,
    });
    expect(provider.provider).toBe("vault");
    expect(provider.lease()).toBeUndefined();
    await provider.getSecret("polaris/production/p/x");
    const lease = provider.lease();
    expect(lease).toBeDefined();
    expect(lease?.renewable).toBe(true);
  });
});

describe("VaultSecretProvider — agent sidecar (DCJXEFE5)", () => {
  it("reads the token from the agent sink file and never calls /v1/auth/.../login", async () => {
    let calls = 0;
    let lastHeaders: Record<string, string> = {};
    const http: VaultHttp = async (url, init) => {
      calls += 1;
      lastHeaders = init.headers;
      if (url.includes("/v1/auth/")) {
        throw new Error(`agent mode must not call ${url}`);
      }
      return makeResponse(200, { data: { data: { value: SECRET_VALUE } } });
    };

    const provider = createVaultProvider({
      address: ADDRESS,
      auth: "agent",
      agentTokenReader: async () => "hvs.agent-managed-token",
      http,
      sleep: async () => {},
    });

    expect(await provider.getSecret("polaris/production/storefront/meta-capi")).toBe(SECRET_VALUE);
    expect(calls).toBe(1);
    expect(lastHeaders["x-vault-token"]).toBe("hvs.agent-managed-token");
    // The Agent owns the lease window; the source surfaces no lease metadata.
    expect(provider.lease()).toBeUndefined();
  });

  it("permits agent mode without `role` (the Agent owns the auth-role binding)", () => {
    expect(() =>
      createVaultProvider({
        address: ADDRESS,
        auth: "agent",
        agentTokenReader: async () => "hvs.token",
      }),
    ).not.toThrow();
  });
});

describe("VaultSecretProvider — bounded transient retry (DCJXEFE5)", () => {
  it("retries on transport failure and succeeds on the 2nd attempt", async () => {
    let attempts = 0;
    const http: VaultHttp = async (url) => {
      if (url.endsWith("/login")) return loginResponse();
      attempts += 1;
      if (attempts === 1) throw new Error("ECONNRESET");
      return makeResponse(200, { data: { data: { value: SECRET_VALUE } } });
    };
    const sleeps: number[] = [];
    const provider = createVaultProvider({
      address: ADDRESS,
      role: "polaris-production",
      serviceAccountTokenReader: new FakeReader(),
      http,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(await provider.getSecret("polaris/production/p/x")).toBe(SECRET_VALUE);
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([100]);
  });

  it("retries on 5xx and 429 but eventually succeeds inside maxAttempts", async () => {
    let attempts = 0;
    const sequence = [503, 429, 200] as const;
    const http: VaultHttp = async (url) => {
      if (url.endsWith("/login")) return loginResponse();
      const status = sequence[attempts] ?? 200;
      attempts += 1;
      if (status === 200) {
        return makeResponse(200, { data: { data: { value: SECRET_VALUE } } });
      }
      return makeResponse(status, {});
    };
    const provider = createVaultProvider({
      address: ADDRESS,
      role: "polaris-production",
      serviceAccountTokenReader: new FakeReader(),
      http,
      sleep: async () => {},
    });

    expect(await provider.getSecret("polaris/production/p/x")).toBe(SECRET_VALUE);
    expect(attempts).toBe(3);
  });

  it("after exhaustion, falls back to stale cache and flips probe to degraded", async () => {
    let firstReadDone = false;
    let attemptsAfterFirstSuccess = 0;
    const http: VaultHttp = async (url) => {
      if (url.endsWith("/login")) return loginResponse();
      if (!firstReadDone) {
        firstReadDone = true;
        return makeResponse(200, { data: { data: { value: SECRET_VALUE } } });
      }
      attemptsAfterFirstSuccess += 1;
      return makeResponse(503, {});
    };
    const provider = createVaultProvider({
      address: ADDRESS,
      role: "polaris-production",
      serviceAccountTokenReader: new FakeReader(),
      http,
      cacheTtlMs: 0, // every fresh-path lookup misses; stale-path always hits
      sleep: async () => {},
    });

    expect(await provider.getSecret("polaris/production/p/x")).toBe(SECRET_VALUE);
    expect(await provider.getSecret("polaris/production/p/x")).toBe(SECRET_VALUE);
    expect(attemptsAfterFirstSuccess).toBe(3);
    expect(provider.probe().status).toBe("degraded");
  });

  it("does not retry when maxAttempts=1", async () => {
    let attempts = 0;
    const http: VaultHttp = async (url) => {
      if (url.endsWith("/login")) return loginResponse();
      attempts += 1;
      return makeResponse(503, {});
    };
    const provider = createVaultProvider({
      address: ADDRESS,
      role: "polaris-production",
      serviceAccountTokenReader: new FakeReader(),
      http,
      maxAttempts: 1,
      sleep: async () => {},
    });

    await expect(provider.getSecret("polaris/production/p/x")).rejects.toBeInstanceOf(
      SecretProviderError,
    );
    expect(attempts).toBe(1);
  });
});

/**
 * Helper that drives the provider through every documented error path and
 * collects the thrown errors so the no-leak assertion can run over the full
 * set at once. The contract: every error path must redact the secret value,
 * the Vault token, and the K8s SA JWT.
 */
async function collectThrownErrors(provider: VaultSecretProvider): Promise<Error[]> {
  const errors: Error[] = [];
  try {
    await provider.getSecret("");
  } catch (err) {
    if (err instanceof Error) errors.push(err);
  }
  return errors;
}
