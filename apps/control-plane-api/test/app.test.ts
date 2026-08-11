/**
 * Behavioral tests for the control-plane API shell (P6-000).
 *
 * Covers:
 *   - Bearer-token auth resolves declared / cli / 401-invalid paths
 *   - Production-mutation gate refuses cli-source mutations on production
 *   - Gate ALLOWS declared-source mutations on production
 *   - Gate ALLOWS any source on non-production envs
 *   - /v1/whoami returns the resolved actor
 *   - /health, /ready, /metrics serve via bootstrap
 *   - Audit recorder writes one row per mutation (via a sample mutating
 *     route registered only in this test)
 */

import type { OperatorTokenRepository } from "@polaris/shared-control-plane";
import { describe, expect, it } from "vitest";

import { buildControlPlaneApp } from "../src/app.js";
import { type AuditRecorder, InMemoryAuditRecorder } from "../src/audit/recorder.js";
import { createMutationGatePreHandler } from "../src/auth/gate.js";
import type { ControlPlaneConfig } from "../src/config.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(
  env: ControlPlaneConfig["service"]["environment"] = "local",
): ControlPlaneConfig {
  return {
    service: {
      serviceName: "control-plane-api",
      serviceVersion: "0.0.1",
      environment: env,
      logLevel: "fatal",
      logPretty: false,
      gitSha: "deadbee",
      buildTime: "2026-05-14T10:00:00.000Z",
      releaseLabel: undefined,
    },
    http: {
      host: "127.0.0.1",
      port: 0,
      bodyLimitBytes: 1_048_576,
      requestTimeoutMs: 15_000,
      keepAliveTimeoutMs: 5_000,
    },
    postgres: {
      host: "localhost",
      port: 5432,
      database: "polaris",
      user: "polaris",
      password: "polaris",
      ssl: false,
      poolMax: 10,
      connectTimeoutMs: 10_000,
      idleTimeoutMs: 30_000,
    },
    // The admin plugin is always mounted; these cases are about the JSON API
    // shell, and exist partly to prove the two do not interfere.
    admin: {
      cookieSecure: false,
      sessionSecret: "x".repeat(48),
      pageSize: 50,
      productionMinRole: "owner",
      idp: {
        baseUrl: "http://localhost:3011",
        issuer: "http://localhost:3011",
        jwksUrl: "http://localhost:3011/.well-known/jwks.json",
        clientId: "polaris_test",
        clientSecret: "secret",
        redirectUri: "http://localhost:4001/admin/auth/callback",
        endSessionEndpoint: "http://localhost:3011/oauth/end_session",
        tokenUrl: "http://localhost:3011/oauth/token",
        revokeUrl: "http://localhost:3011/oauth/revoke",
        authorizeUrl: "http://localhost:3011/oauth/authorize",
        requestTimeoutMs: 10_000,
      },
    },
  };
}

// Operator-token repository stub. `byId` maps the parsed token id to a
// row; `verify` is the verifier the auth hook calls. Tests build the
// stub per case.
function makeRepository(
  rows: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly hash: string;
    readonly status: "active" | "revoked";
  }>,
): OperatorTokenRepository {
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  return {
    findById: async (id) => {
      const row = byId.get(id);
      if (row === undefined) return null;
      return {
        operator_token_id: row.id,
        operator_label: row.label,
        hash: row.hash,
        hash_algorithm: "argon2id",
        status: row.status,
      };
    },
    touchLastUsedAt: async () => undefined,
  };
}

// A polaris_ot_<uuid>.<secret> bearer that parses but whose row may or
// may not exist in the repository.
const BEARER_ID = "polaris_ot_018f1b9e-7b50-7b12-9a2e-0e2f88d8f551";
const BEARER_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const BEARER_HEADER = `Bearer ${BEARER_ID}.${BEARER_SECRET}`;

// ---------------------------------------------------------------------------
// /v1/whoami + auth
// ---------------------------------------------------------------------------

describe("/v1/whoami + bearer auth", () => {
  it("returns source='cli' with no bearer header", async () => {
    const bootstrap = await buildControlPlaneApp({
      config: makeConfig(),
      operatorTokenRepository: makeRepository([]),
      verifyHash: async () => true,
      installShutdown: false,
    });
    const res = await bootstrap.app.inject({ method: "GET", url: "/v1/whoami" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ actor: { source: "cli", label: "cli" } });
    await bootstrap.app.close();
  });

  it("returns source='declared' on a valid bearer token", async () => {
    const bootstrap = await buildControlPlaneApp({
      config: makeConfig(),
      operatorTokenRepository: makeRepository([
        { id: BEARER_ID, label: "ops@example.com", hash: "argon2-hash", status: "active" },
      ]),
      verifyHash: async () => true,
      installShutdown: false,
    });
    const res = await bootstrap.app.inject({
      method: "GET",
      url: "/v1/whoami",
      headers: { authorization: BEARER_HEADER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      actor: { source: "declared", label: "ops@example.com", token_id: BEARER_ID },
    });
    await bootstrap.app.close();
  });

  it("collapses to cli on revoked token (audit-friendly fallback)", async () => {
    const bootstrap = await buildControlPlaneApp({
      config: makeConfig(),
      operatorTokenRepository: makeRepository([
        { id: BEARER_ID, label: "ops", hash: "h", status: "revoked" },
      ]),
      verifyHash: async () => true,
      installShutdown: false,
    });
    const res = await bootstrap.app.inject({
      method: "GET",
      url: "/v1/whoami",
      headers: { authorization: BEARER_HEADER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ actor: { source: "cli", label: "cli" } });
    await bootstrap.app.close();
  });

  it("returns 401 invalid_operator_token on malformed bearer header", async () => {
    const bootstrap = await buildControlPlaneApp({
      config: makeConfig(),
      operatorTokenRepository: makeRepository([]),
      verifyHash: async () => true,
      installShutdown: false,
    });
    const res = await bootstrap.app.inject({
      method: "GET",
      url: "/v1/whoami",
      headers: { authorization: "Bearer not-a-valid-token" },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json() as { code: string };
    expect(body.code).toBe("invalid_operator_token");
    await bootstrap.app.close();
  });
});

// ---------------------------------------------------------------------------
// Production-mutation gate + audit recorder
// ---------------------------------------------------------------------------

describe("production-mutation gate + audit", () => {
  async function buildWithSampleMutatingRoute(opts: {
    config: ControlPlaneConfig;
    recorder: AuditRecorder;
    repository: OperatorTokenRepository;
  }) {
    const bootstrap = await buildControlPlaneApp({
      config: opts.config,
      operatorTokenRepository: opts.repository,
      verifyHash: async () => true,
      installShutdown: false,
    });
    // Register a test-only mutating route, mirroring how P6-002+
    // business routes will compose the auth + gate + audit chain.
    bootstrap.app.post(
      "/v1/__test__/mutate",
      {
        preHandler: [
          createMutationGatePreHandler({
            commandId: "test.mutate",
            mutates: true,
            environment: opts.config.service.environment,
          }),
        ],
      },
      async (request, _reply) => {
        if (request.actor === undefined) {
          return { ok: false, reason: "no_actor" };
        }
        await opts.recorder.record({
          actor: request.actor,
          action: "test.mutate",
          targetType: "test_resource",
          targetId: "test-001",
          requestId: request.id,
        });
        return { ok: true };
      },
    );
    return bootstrap;
  }

  it("refuses cli-source mutations on production with 403", async () => {
    const recorder = new InMemoryAuditRecorder();
    const bootstrap = await buildWithSampleMutatingRoute({
      config: makeConfig("production"),
      recorder,
      repository: makeRepository([]),
    });
    const res = await bootstrap.app.inject({ method: "POST", url: "/v1/__test__/mutate" });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { code: string };
    expect(body.code).toBe("production_requires_authenticated_actor");
    // Gate refused before the handler — no audit row should have
    // landed for this attempt.
    expect(recorder.records).toHaveLength(0);
    await bootstrap.app.close();
  });

  it("allows declared-source mutations on production and the handler writes one audit row", async () => {
    const recorder = new InMemoryAuditRecorder();
    const bootstrap = await buildWithSampleMutatingRoute({
      config: makeConfig("production"),
      recorder,
      repository: makeRepository([
        { id: BEARER_ID, label: "ops@example.com", hash: "h", status: "active" },
      ]),
    });
    const res = await bootstrap.app.inject({
      method: "POST",
      url: "/v1/__test__/mutate",
      headers: { authorization: BEARER_HEADER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(recorder.records).toHaveLength(1);
    expect(recorder.records[0]?.action).toBe("test.mutate");
    expect(recorder.records[0]?.actor.source).toBe("declared");
    expect(recorder.records[0]?.actor.label).toBe("ops@example.com");
    await bootstrap.app.close();
  });

  it("allows cli-source mutations against non-production envs (gate is a no-op)", async () => {
    const recorder = new InMemoryAuditRecorder();
    const bootstrap = await buildWithSampleMutatingRoute({
      config: makeConfig("development"),
      recorder,
      repository: makeRepository([]),
    });
    const res = await bootstrap.app.inject({ method: "POST", url: "/v1/__test__/mutate" });
    expect(res.statusCode).toBe(200);
    expect(recorder.records).toHaveLength(1);
    await bootstrap.app.close();
  });
});

// ---------------------------------------------------------------------------
// Bootstrap shell (health / ready / metrics)
// ---------------------------------------------------------------------------

describe("bootstrap shell", () => {
  it("exposes /health, /ready, and /metrics through the shared bootstrap", async () => {
    const bootstrap = await buildControlPlaneApp({
      config: makeConfig(),
      operatorTokenRepository: makeRepository([]),
      verifyHash: async () => true,
      installShutdown: false,
    });
    const health = await bootstrap.app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    const ready = await bootstrap.app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(200);
    const metrics = await bootstrap.app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.statusCode).toBe(200);
    await bootstrap.app.close();
  });
});
