import { describe, expect, it } from "vitest";

import {
  type ServiceAccountTokenReader,
  type VaultHttp,
  type VaultHttpInit,
  type VaultHttpResponse,
  VaultTokenManager,
} from "../src/providers/vault-token-manager.js";

/**
 * Sentinel JWT used by the fake K8s reader. If it ever appears in an error
 * message, the redaction contract has been violated.
 */
const SA_JWT = "eyJhbGciOiJSUzI1NiJ9.fake.serviceaccount.jwt";
/**
 * Sentinel Vault token. Same rule.
 */
const VAULT_TOKEN = "hvs.fake_vault_client_token_should_not_leak";

class FakeReader implements ServiceAccountTokenReader {
  public reads = 0;
  constructor(private readonly value: string) {}
  public async read(): Promise<string> {
    this.reads += 1;
    return this.value;
  }
}

class FakeClock {
  public t = 1_000_000;
  public now(): number {
    return this.t;
  }
}

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

function makeResponse(status: number, jsonPayload: unknown): VaultHttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: () => Promise.resolve(JSON.stringify(jsonPayload)),
    json: () => Promise.resolve(jsonPayload),
  };
}

function recordingHttp(responder: (call: RecordedCall) => VaultHttpResponse): {
  http: VaultHttp;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const http: VaultHttp = async (url: string, init: VaultHttpInit) => {
    const call: RecordedCall = {
      url,
      method: init.method,
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
    };
    calls.push(call);
    return responder(call);
  };
  return { http, calls };
}

describe("VaultTokenManager", () => {
  it("authenticates with the K8s SA JWT and returns the Vault token", async () => {
    const clock = new FakeClock();
    const reader = new FakeReader(SA_JWT);
    const { http, calls } = recordingHttp(() =>
      makeResponse(200, {
        auth: { client_token: VAULT_TOKEN, lease_duration: 3600, renewable: true },
      }),
    );
    const mgr = new VaultTokenManager({
      address: "https://vault.svc:8200",
      kubernetesMount: "kubernetes",
      role: "polaris-production",
      serviceAccountTokenReader: reader,
      http,
      now: () => clock.now(),
    });
    const token = await mgr.token();
    expect(token).toBe(VAULT_TOKEN);
    expect(reader.reads).toBe(1);
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe("https://vault.svc:8200/v1/auth/kubernetes/login");
    expect(calls[0]?.method).toBe("POST");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.role).toBe("polaris-production");
    expect(body.jwt).toBe(SA_JWT);
  });

  it("reuses the active token while well inside the lease window", async () => {
    const clock = new FakeClock();
    const reader = new FakeReader(SA_JWT);
    const { http, calls } = recordingHttp(() =>
      makeResponse(200, {
        auth: { client_token: VAULT_TOKEN, lease_duration: 3600, renewable: true },
      }),
    );
    const mgr = new VaultTokenManager({
      address: "https://vault.svc:8200",
      kubernetesMount: "kubernetes",
      role: "polaris-production",
      serviceAccountTokenReader: reader,
      http,
      now: () => clock.now(),
    });
    await mgr.token();
    clock.t += 60_000; // 1 minute later, well under the 1h lease
    await mgr.token();
    expect(calls.length).toBe(1);
  });

  it("renews the token when near expiry instead of re-authenticating", async () => {
    const clock = new FakeClock();
    const reader = new FakeReader(SA_JWT);
    const { http, calls } = recordingHttp((call) => {
      if (call.url.endsWith("/v1/auth/kubernetes/login")) {
        return makeResponse(200, {
          auth: { client_token: "hvs.first_token", lease_duration: 100, renewable: true },
        });
      }
      if (call.url.endsWith("/v1/auth/token/renew-self")) {
        return makeResponse(200, {
          auth: { client_token: "hvs.second_token", lease_duration: 100, renewable: true },
        });
      }
      throw new Error("unexpected url " + call.url);
    });
    const mgr = new VaultTokenManager({
      address: "https://vault.svc:8200",
      kubernetesMount: "kubernetes",
      role: "polaris-production",
      serviceAccountTokenReader: reader,
      http,
      now: () => clock.now(),
      renewAtFraction: 0.25,
    });
    const first = await mgr.token();
    expect(first).toBe("hvs.first_token");
    // Lease was 100s; we want to be inside 25% remaining => advance >75 seconds.
    clock.t += 80_000;
    const second = await mgr.token();
    expect(second).toBe("hvs.second_token");
    // 2 calls total: login then renew-self.
    expect(calls.length).toBe(2);
    expect(calls[1]?.url).toContain("renew-self");
    expect(calls[1]?.headers["x-vault-token"]).toBe("hvs.first_token");
    // Reader was consulted only at login time; renewal does not re-read the JWT.
    expect(reader.reads).toBe(1);
  });

  it("falls back to a full re-auth when renewal returns 403", async () => {
    const clock = new FakeClock();
    const reader = new FakeReader(SA_JWT);
    let loginCount = 0;
    const { http, calls } = recordingHttp((call) => {
      if (call.url.endsWith("/v1/auth/kubernetes/login")) {
        loginCount += 1;
        return makeResponse(200, {
          auth: {
            client_token: `hvs.login_${loginCount}`,
            lease_duration: 100,
            renewable: true,
          },
        });
      }
      if (call.url.endsWith("/v1/auth/token/renew-self")) {
        return makeResponse(403, { errors: ["lease expired"] });
      }
      throw new Error("unexpected url");
    });
    const mgr = new VaultTokenManager({
      address: "https://vault.svc:8200",
      kubernetesMount: "kubernetes",
      role: "polaris-production",
      serviceAccountTokenReader: reader,
      http,
      now: () => clock.now(),
    });
    await mgr.token();
    clock.t += 90_000; // deep into the renewal window
    const after = await mgr.token();
    expect(after).toBe("hvs.login_2");
    // Re-auth re-reads the SA JWT.
    expect(reader.reads).toBe(2);
    // login + renew(403) + login = 3 calls
    expect(calls.length).toBe(3);
  });

  it("surfaces a 403 login as an opaque auth error (no JWT in message)", async () => {
    const reader = new FakeReader(SA_JWT);
    const { http } = recordingHttp(() => makeResponse(403, { errors: ["role not bound"] }));
    const mgr = new VaultTokenManager({
      address: "https://vault.svc:8200",
      kubernetesMount: "kubernetes",
      role: "polaris-production",
      serviceAccountTokenReader: reader,
      http,
    });
    let caught: Error | undefined;
    try {
      await mgr.token();
    } catch (err) {
      if (err instanceof Error) caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught?.message ?? "").not.toContain(SA_JWT);
    expect(caught?.message ?? "").toContain("kubernetes auth rejected");
  });

  it("rejects construction when address ends with '/'", () => {
    expect(
      () =>
        new VaultTokenManager({
          address: "https://vault.svc:8200/",
          kubernetesMount: "kubernetes",
          role: "polaris-production",
          serviceAccountTokenReader: new FakeReader(SA_JWT),
        }),
    ).toThrow(TypeError);
  });

  it("rejects renewAtFraction outside (0, 1)", () => {
    expect(
      () =>
        new VaultTokenManager({
          address: "https://vault.svc:8200",
          kubernetesMount: "kubernetes",
          role: "polaris-production",
          serviceAccountTokenReader: new FakeReader(SA_JWT),
          renewAtFraction: 0,
        }),
    ).toThrow(TypeError);
    expect(
      () =>
        new VaultTokenManager({
          address: "https://vault.svc:8200",
          kubernetesMount: "kubernetes",
          role: "polaris-production",
          serviceAccountTokenReader: new FakeReader(SA_JWT),
          renewAtFraction: 1,
        }),
    ).toThrow(TypeError);
  });

  it("shares a single in-flight login across concurrent callers", async () => {
    const reader = new FakeReader(SA_JWT);
    let resolveLogin: ((r: VaultHttpResponse) => void) | undefined;
    const loginPromise = new Promise<VaultHttpResponse>((resolve) => {
      resolveLogin = resolve;
    });
    const calls: string[] = [];
    const http: VaultHttp = async (url) => {
      calls.push(url);
      return loginPromise;
    };
    const mgr = new VaultTokenManager({
      address: "https://vault.svc:8200",
      kubernetesMount: "kubernetes",
      role: "polaris-production",
      serviceAccountTokenReader: reader,
      http,
    });
    const a = mgr.token();
    const b = mgr.token();
    resolveLogin?.(
      makeResponse(200, {
        auth: { client_token: VAULT_TOKEN, lease_duration: 3600, renewable: true },
      }),
    );
    const [resA, resB] = await Promise.all([a, b]);
    expect(resA).toBe(VAULT_TOKEN);
    expect(resB).toBe(VAULT_TOKEN);
    expect(calls.length).toBe(1);
    expect(reader.reads).toBe(1);
  });

  it("invalidate forces the next token() to re-auth", async () => {
    const reader = new FakeReader(SA_JWT);
    let count = 0;
    const { http } = recordingHttp(() => {
      count += 1;
      return makeResponse(200, {
        auth: {
          client_token: `hvs.token_${count}`,
          lease_duration: 3600,
          renewable: true,
        },
      });
    });
    const mgr = new VaultTokenManager({
      address: "https://vault.svc:8200",
      kubernetesMount: "kubernetes",
      role: "polaris-production",
      serviceAccountTokenReader: reader,
      http,
    });
    const first = await mgr.token();
    mgr.invalidate();
    const second = await mgr.token();
    expect(first).toBe("hvs.token_1");
    expect(second).toBe("hvs.token_2");
  });

  it("does not include the Vault token in error messages when the login response is malformed", async () => {
    const reader = new FakeReader(SA_JWT);
    // 200 OK but `auth` is missing.
    const { http } = recordingHttp(() => makeResponse(200, { data: { x: VAULT_TOKEN } }));
    const mgr = new VaultTokenManager({
      address: "https://vault.svc:8200",
      kubernetesMount: "kubernetes",
      role: "polaris-production",
      serviceAccountTokenReader: reader,
      http,
    });
    let caught: Error | undefined;
    try {
      await mgr.token();
    } catch (err) {
      if (err instanceof Error) caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught?.message ?? "").not.toContain(VAULT_TOKEN);
  });
});
