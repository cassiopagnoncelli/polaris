import { describe, expect, it } from "vitest";

import { buildIngesterApp } from "../src/app.js";
import type { IngesterConfig } from "../src/config.js";
import { NOT_IMPLEMENTED_CODE } from "../src/routes/events.js";

const PROBLEM_JSON = "application/problem+json; charset=utf-8" as const;

const testConfig: IngesterConfig = {
  service: {
    serviceName: "ingester-api",
    serviceVersion: "0.0.1",
    environment: "local",
    logLevel: "info",
    logPretty: false,
    gitSha: "deadbee",
    buildTime: "2026-05-12T10:00:00.000Z",
  },
  http: {
    host: "127.0.0.1",
    port: 0,
    bodyLimitBytes: 1_048_576,
    requestTimeoutMs: 15_000,
    keepAliveTimeoutMs: 5_000,
  },
};

async function buildTestApp(overrides: Partial<Parameters<typeof buildIngesterApp>[0]> = {}) {
  return buildIngesterApp({
    config: testConfig,
    installShutdown: false,
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

  it("returns 501 not_implemented Problem Details from POST /v1/events", async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/events",
        payload: { events: [] },
      });
      expect(res.statusCode).toBe(501);
      expect(res.headers["content-type"]).toBe(PROBLEM_JSON);
      const body = res.json() as Record<string, unknown>;
      expect(body.code).toBe(NOT_IMPLEMENTED_CODE);
      expect(body.status).toBe(501);
      expect(body.type).toBe("https://docs.polaris/errors/not_implemented");
      expect(typeof body.request_id).toBe("string");
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
