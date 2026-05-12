import { describe, expect, it } from "vitest";

import { buildIngesterApp } from "../src/app.js";
import { API_KEY_HEADER, AUTH_PROBLEM_CODES } from "../src/auth/index.js";
import { InMemoryDedupeStore } from "../src/dedupe/index.js";
import {
  InMemoryApiKeyRepository,
  RecordingProducer,
  buildTestCatalog,
  testConfig,
} from "./fixtures.js";

const PROBLEM_JSON = "application/problem+json; charset=utf-8" as const;

function repoWithKey(): InMemoryApiKeyRepository {
  const repo = new InMemoryApiKeyRepository();
  repo.set({
    apiKeyId: "test-key-id",
    projectId: "checkout",
    environment: "production",
    sourceId: "storefront-web",
    sourceType: "web",
    hash: "argon2id-hash-irrelevant-test-stub",
    hashAlgorithm: "argon2id",
    status: "active",
  });
  return repo;
}

async function buildTestApp(overrides: Partial<Parameters<typeof buildIngesterApp>[0]> = {}) {
  return buildIngesterApp({
    config: testConfig,
    installShutdown: false,
    apiKeyRepository: repoWithKey(),
    catalog: buildTestCatalog(),
    producer: new RecordingProducer() as unknown as Parameters<
      typeof buildIngesterApp
    >[0]["producer"],
    dedupe: new InMemoryDedupeStore(),
    ...overrides,
  });
}

describe("buildIngesterApp", () => {
  it("exposes /health with the ingester service identity", async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body.status).toBe("ok");
      expect(body.service).toBe("ingester-api");
      expect(body.version).toBe("0.0.1");
      expect(body.environment).toBe("local");
      expect(body.git_sha).toBe("deadbee");
      expect(body.build_time).toBe("2026-05-12T10:00:00.000Z");
    } finally {
      await app.close();
    }
  });

  it("exposes /ready returning 200 when no probes are configured", async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({ method: "GET", url: "/ready" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { status: string; probes: unknown[] };
      expect(body.status).toBe("ready");
      expect(body.probes).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("rolls /ready down to 503 when any probe reports down", async () => {
    const { app } = await buildTestApp({
      readinessProbes: [
        async function redpanda() {
          return { name: "redpanda", status: "down", detail: "broker unreachable" };
        },
      ],
    });
    try {
      const res = await app.inject({ method: "GET", url: "/ready" });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { status: string; probes: { name: string; status: string }[] };
      expect(body.status).toBe("not_ready");
      expect(body.probes[0]?.name).toBe("redpanda");
      expect(body.probes[0]?.status).toBe("down");
    } finally {
      await app.close();
    }
  });

  it("returns RFC 7807 Problem Details for unknown routes", async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({ method: "GET", url: "/does-not-exist" });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toBe(PROBLEM_JSON);
      const body = res.json() as Record<string, unknown>;
      expect(body.code).toBe("not_found");
      expect(typeof body.request_id).toBe("string");
    } finally {
      await app.close();
    }
  });

  it("echoes a UUIDv7 request_id back as x-request-id", async () => {
    const { app } = await buildTestApp();
    app.get("/__r", async (request) => ({ request_id: request.id }));
    try {
      const res = await app.inject({ method: "GET", url: "/__r" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { request_id: string };
      expect(body.request_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(res.headers["x-request-id"]).toBe(body.request_id);
    } finally {
      await app.close();
    }
  });

  it("returns 401 missing_api_key when POST /v1/events lacks the header", async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/events",
        payload: { events: [] },
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers["content-type"]).toBe(PROBLEM_JSON);
      const body = res.json() as Record<string, unknown>;
      expect(body.code).toBe(AUTH_PROBLEM_CODES.missingApiKey);
      expect(body.status).toBe(401);
      expect(typeof body.request_id).toBe("string");
    } finally {
      await app.close();
    }
  });

  it("returns 401 invalid_api_key when POST /v1/events is given a bad key", async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/events",
        payload: { events: [] },
        headers: { [API_KEY_HEADER]: "no-such-key.secret" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers["content-type"]).toBe(PROBLEM_JSON);
      const body = res.json() as Record<string, unknown>;
      expect(body.code).toBe(AUTH_PROBLEM_CODES.invalidApiKey);
      expect(body.status).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("returns 401 when a real argon2 verifier rejects the test stub hash", async () => {
    // The real verifier is exercised in hash.test.ts. Here we only prove
    // the wire path: a real key with a wrong secret is rejected before the
    // ingest handler runs.
    const repo = repoWithKey();
    const { app } = await buildTestApp({ apiKeyRepository: repo });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/events",
        payload: { events: [] },
        headers: { [API_KEY_HEADER]: "test-key-id.some-secret" },
      });
      expect(res.statusCode).toBe(401);
      const body = res.json() as Record<string, unknown>;
      expect(body.code).toBe(AUTH_PROBLEM_CODES.invalidApiKey);
    } finally {
      await app.close();
    }
  });

  it("invokes the OpenAPI setup hook with the ingester metadata", async () => {
    const captured: Array<{ title: string; version: string; description?: string }> = [];
    const { app } = await buildTestApp({
      openApiSetup: async (_app, meta) => {
        captured.push({
          title: meta.title,
          version: meta.version,
          ...(meta.description !== undefined ? { description: meta.description } : {}),
        });
      },
    });
    try {
      expect(captured).toHaveLength(1);
      expect(captured[0]?.title).toBe("Polaris Ingester API");
      expect(captured[0]?.version).toBe("0.0.1");
      expect(captured[0]?.description).toContain("Polaris SDKs");
    } finally {
      await app.close();
    }
  });

  it("triggers shutdown tasks and exits cleanly", async () => {
    const calls: string[] = [];
    let exitCode = -1;
    const { app, shutdown } = await buildTestApp({
      installShutdown: true,
      shutdownExit: (code) => {
        exitCode = code;
      },
      shutdownTasks: [
        async () => {
          calls.push("kafka-producer-close");
        },
      ],
    });
    // We don't want the SIGTERM/SIGINT listener installed by the shared
    // bootstrap to linger after the test, so call shutdown manually.
    await shutdown("SIGTERM");
    expect(calls).toEqual(["kafka-producer-close"]);
    expect(exitCode).toBe(0);
    expect(app.server.listening).toBe(false);
  });
});
