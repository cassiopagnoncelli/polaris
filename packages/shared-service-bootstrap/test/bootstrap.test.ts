import { describe, expect, it } from "vitest";

import {
  bootstrapService,
  PROBLEM_CONTENT_TYPE,
  POLARIS_REQUEST_ID_HEADER,
  ProblemError,
  RESPONSE_REQUEST_ID_HEADER,
  type ServiceInfo,
} from "../src/index.js";

const testInfo: ServiceInfo = {
  serviceName: "test-service",
  serviceVersion: "1.2.3",
  gitSha: "abc1234",
  buildTime: "2026-05-12T10:00:00.000Z",
  environment: "local",
};

async function buildTestService() {
  return bootstrapService({
    info: testInfo,
    installShutdown: false,
    fastify: {
      // Silence per-request logging during tests.
      disableRequestLogging: true,
    },
  });
}

describe("bootstrapService", () => {
  it("exposes /health with build metadata", async () => {
    const { app } = await buildTestService();
    try {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body.status).toBe("ok");
      expect(body.service).toBe("test-service");
      expect(body.version).toBe("1.2.3");
      expect(body.git_sha).toBe("abc1234");
      expect(body.build_time).toBe("2026-05-12T10:00:00.000Z");
      expect(body.environment).toBe("local");
      expect(typeof body.time).toBe("string");
    } finally {
      await app.close();
    }
  });

  it("exposes /health.release_label when ServiceInfo carries one", async () => {
    const { app } = await bootstrapService({
      info: { ...testInfo, releaseLabel: "2026-q2-r1" },
      installShutdown: false,
    });
    try {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body.release_label).toBe("2026-q2-r1");
    } finally {
      await app.close();
    }
  });

  it("omits /health.release_label cleanly when ServiceInfo has none", async () => {
    const { app } = await buildTestService();
    try {
      const res = await app.inject({ method: "GET", url: "/health" });
      const body = res.json() as Record<string, unknown>;
      // `release_label` may be present as `undefined` (JSON.stringify drops
      // it) or absent entirely; either way it must NOT carry a misleading
      // value when the ServiceInfo did not set one.
      expect(body.release_label).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("exposes /ready returning 200 when no probes are configured", async () => {
    const { app } = await buildTestService();
    try {
      const res = await app.inject({ method: "GET", url: "/ready" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body.status).toBe("ready");
      expect(body.probes).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("aggregates readiness probes and rolls down to 503 on any failure", async () => {
    const { app } = await bootstrapService({
      info: testInfo,
      installShutdown: false,
      readinessProbes: [
        async function postgres() {
          return { name: "postgres", status: "up" };
        },
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
      const names = body.probes.map((p) => p.name);
      expect(names).toContain("postgres");
      expect(names).toContain("redpanda");
    } finally {
      await app.close();
    }
  });

  it("catches probe throws and records them as down", async () => {
    const { app } = await bootstrapService({
      info: testInfo,
      installShutdown: false,
      readinessProbes: [
        async function postgres() {
          throw new Error("boom");
        },
      ],
    });
    try {
      const res = await app.inject({ method: "GET", url: "/ready" });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { probes: { name: string; status: string; detail?: string }[] };
      expect(body.probes[0]?.status).toBe("down");
      expect(body.probes[0]?.detail).toBe("boom");
    } finally {
      await app.close();
    }
  });

  it("exposes /metrics with Prometheus content type (empty body by default)", async () => {
    const { app } = await buildTestService();
    try {
      const res = await app.inject({ method: "GET", url: "/metrics" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/plain/);
      expect(res.body).toBe("");
    } finally {
      await app.close();
    }
  });

  it("forwards to a configured metrics producer", async () => {
    const { app } = await bootstrapService({
      info: testInfo,
      installShutdown: false,
      metrics: { producer: () => "polaris_test_total 1\n" },
    });
    try {
      const res = await app.inject({ method: "GET", url: "/metrics" });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe("polaris_test_total 1\n");
    } finally {
      await app.close();
    }
  });

  it("returns RFC 7807 Problem Details on a thrown ProblemError", async () => {
    const { app } = await buildTestService();
    app.get("/boom", async () => {
      throw new ProblemError({
        status: 401,
        code: "invalid_api_key",
        title: "Invalid API key",
        detail: "The provided API key is invalid or revoked.",
      });
    });
    try {
      const res = await app.inject({ method: "GET", url: "/boom" });
      expect(res.statusCode).toBe(401);
      expect(res.headers["content-type"]).toBe(`${PROBLEM_CONTENT_TYPE}; charset=utf-8`);
      const body = res.json() as Record<string, unknown>;
      expect(body.type).toBe("https://docs.polaris/errors/invalid_api_key");
      expect(body.title).toBe("Invalid API key");
      expect(body.status).toBe(401);
      expect(body.code).toBe("invalid_api_key");
      expect(body.detail).toBe("The provided API key is invalid or revoked.");
      expect(typeof body.request_id).toBe("string");
      expect(body.request_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    } finally {
      await app.close();
    }
  });

  it("maps Fastify validation failures to invalid_request with the issues attached", async () => {
    const { app } = await buildTestService();
    app.post(
      "/echo",
      {
        schema: {
          body: {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string", minLength: 1 } },
          },
        },
      },
      async () => ({}),
    );
    try {
      const res = await app.inject({ method: "POST", url: "/echo", payload: {} });
      expect(res.statusCode).toBe(400);
      expect(res.headers["content-type"]).toBe(`${PROBLEM_CONTENT_TYPE}; charset=utf-8`);
      const body = res.json() as Record<string, unknown>;
      expect(body.code).toBe("invalid_request");
      expect(Array.isArray(body["validation"])).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("maps unhandled errors to 500 internal_error and omits the detail", async () => {
    const { app, logger } = await buildTestService();
    // Silence error log during this test by raising the level.
    logger.level = "silent";
    app.get("/explode", async () => {
      throw new Error("connection refused");
    });
    try {
      const res = await app.inject({ method: "GET", url: "/explode" });
      expect(res.statusCode).toBe(500);
      expect(res.headers["content-type"]).toBe(`${PROBLEM_CONTENT_TYPE}; charset=utf-8`);
      const body = res.json() as Record<string, unknown>;
      expect(body.status).toBe(500);
      expect(body.code).toBe("internal_error");
      // Detail must not leak internal error messages by default.
      expect(body.detail).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("returns Problem Details for unknown routes", async () => {
    const { app } = await buildTestService();
    try {
      const res = await app.inject({ method: "GET", url: "/this-route-does-not-exist" });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toBe(`${PROBLEM_CONTENT_TYPE}; charset=utf-8`);
      const body = res.json() as Record<string, unknown>;
      expect(body.code).toBe("not_found");
      expect(typeof body.request_id).toBe("string");
    } finally {
      await app.close();
    }
  });

  it("propagates the caller-supplied request_id header onto request.id and the response", async () => {
    const { app } = await buildTestService();
    app.get("/echo-request-id", async (request) => ({ request_id: request.id }));
    try {
      const supplied = "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551";
      const res = await app.inject({
        method: "GET",
        url: "/echo-request-id",
        headers: { [POLARIS_REQUEST_ID_HEADER]: supplied },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body.request_id).toBe(supplied);
      expect(res.headers[RESPONSE_REQUEST_ID_HEADER]).toBe(supplied);
    } finally {
      await app.close();
    }
  });

  it("generates a fresh UUIDv7 request_id when no header is supplied", async () => {
    const { app } = await buildTestService();
    app.get("/r", async (request) => ({ request_id: request.id }));
    try {
      const res = await app.inject({ method: "GET", url: "/r" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      const id = body.request_id as string;
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      // Echoed back to client too.
      expect(res.headers[RESPONSE_REQUEST_ID_HEADER]).toBe(id);
    } finally {
      await app.close();
    }
  });

  it("ignores malformed request_id headers and still generates a fresh ID", async () => {
    const { app } = await buildTestService();
    app.get("/r", async (request) => ({ request_id: request.id }));
    try {
      const res = await app.inject({
        method: "GET",
        url: "/r",
        headers: { [POLARIS_REQUEST_ID_HEADER]: "not-a-uuid" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { request_id: string };
      expect(body.request_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(body.request_id).not.toBe("not-a-uuid");
    } finally {
      await app.close();
    }
  });

  it("invokes the OpenAPI setup hook with the configured metadata", async () => {
    const captured: { title?: string; version?: string }[] = [];
    const { app } = await bootstrapService({
      info: testInfo,
      installShutdown: false,
      openapi: {
        metadata: { title: "Test OpenAPI", version: "9.9.9", description: "for testing" },
        setup: async (_app, meta) => {
          captured.push({ title: meta.title, version: meta.version });
        },
      },
    });
    try {
      expect(captured).toEqual([{ title: "Test OpenAPI", version: "9.9.9" }]);
    } finally {
      await app.close();
    }
  });

  it("derives OpenAPI metadata from service info when no override is supplied", async () => {
    const captured: { title?: string; version?: string }[] = [];
    const { app } = await bootstrapService({
      info: testInfo,
      installShutdown: false,
      openapi: {
        setup: async (_app, meta) => {
          captured.push({ title: meta.title, version: meta.version });
        },
      },
    });
    try {
      expect(captured).toEqual([{ title: "test-service", version: "1.2.3" }]);
    } finally {
      await app.close();
    }
  });

  it("runs graceful shutdown tasks in order and exits zero", async () => {
    const calls: string[] = [];
    let exitCode = -1;
    const { app, shutdown } = await bootstrapService({
      info: testInfo,
      shutdownExit: (code) => {
        exitCode = code;
      },
      shutdownTasks: [
        async () => {
          calls.push("first");
        },
        async () => {
          calls.push("second");
        },
      ],
      // Do not register signal listeners; we trigger manually via shutdown().
      shutdownSignals: [],
    });
    await shutdown("SIGTERM");
    expect(calls).toEqual(["first", "second"]);
    expect(exitCode).toBe(0);
    // Fastify should already be closed.
    expect(app.server.listening).toBe(false);
  });

  it("collects shutdown task errors but continues running the rest", async () => {
    const calls: string[] = [];
    let exitCode = -1;
    const { shutdown } = await bootstrapService({
      info: testInfo,
      shutdownExit: (code) => {
        exitCode = code;
      },
      shutdownTasks: [
        async () => {
          calls.push("first");
          throw new Error("boom");
        },
        async () => {
          calls.push("second");
        },
      ],
      shutdownSignals: [],
    });
    await shutdown("SIGTERM");
    expect(calls).toEqual(["first", "second"]);
    expect(exitCode).toBe(0);
  });

  it("preserves Problem Details shape when a 4xx is thrown from a route", async () => {
    const { app } = await buildTestService();
    app.post(
      "/echo",
      {
        schema: {
          body: {
            type: "object",
            required: ["message"],
            properties: { message: { type: "string", minLength: 1 } },
          },
        },
      },
      async (request) => request.body,
    );
    try {
      const ok = await app.inject({
        method: "POST",
        url: "/echo",
        payload: { message: "hello" },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ message: "hello" });

      const bad = await app.inject({
        method: "POST",
        url: "/echo",
        payload: { message: "" },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.headers["content-type"]).toBe(`${PROBLEM_CONTENT_TYPE}; charset=utf-8`);
    } finally {
      await app.close();
    }
  });
});
