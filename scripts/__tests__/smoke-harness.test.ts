/**
 * Unit coverage for the pure parts of `scripts/smoke/harness.mjs`.
 *
 * Exercising the smoke runner end-to-end requires Docker (RabbitMQ,
 * PostgreSQL, Redis, ClickHouse) and lives in
 * `tests/smoke/vertical-slice.test.ts` gated on POLARIS_SMOKE_DOCKER=1.
 * This file covers the deterministic helpers so a `pnpm test` without
 * Docker still validates the script's shape, envelope assembly, and
 * ClickHouse polling parser.
 */

import { describe, expect, it } from "vitest";
import {
  buildEnvelope,
  formatRow,
  pollClickHouseForEvent,
  postEvent,
  SmokeError,
} from "../smoke/harness.mjs";
import { v7 } from "../smoke/uuidv7.mjs";

describe("buildEnvelope", () => {
  it("produces an envelope with the expected canonical shape", () => {
    const env = buildEnvelope({
      eventId: "11111111-1111-7111-8111-111111111111",
      projectId: "storefront",
      environment: "development",
      sourceId: "payments-api",
      sourceType: "backend",
      occurredAt: "2026-05-12T00:00:00.000Z",
    });
    expect(env.event).toBe("checkout.started");
    expect(env.schema_version).toBe(1);
    expect(env.project_id).toBe("storefront");
    expect(env.environment).toBe("development");
    expect(env.source).toEqual({
      type: "backend",
      id: "payments-api",
      sdk: "polaris-smoke",
      sdk_version: "0.0.0",
    });
    expect(env.occurred_at).toBe("2026-05-12T00:00:00.000Z");
    expect(env.ingested_at).toBe("2026-05-12T00:00:00.000Z");
    expect(env.properties.currency).toBe("USD");
    expect(env.properties.items).toHaveLength(1);
  });

  it("includes a stable cart_id derived from the event_id prefix", () => {
    const env = buildEnvelope({
      eventId: "deadbeef-cafe-7000-8000-000000000000",
      projectId: "p",
      environment: "development",
      sourceId: "s",
      sourceType: "backend",
    });
    expect(env.properties.cart_id).toBe("cart_smoke_deadbeef");
    expect(env.identity.anonymous_id).toBe("anon_smoke_deadbeef");
  });
});

describe("formatRow", () => {
  it("emits a grep-friendly single-line summary", () => {
    const line = formatRow({
      event_id: "abc",
      event: "checkout.started",
      schema_version: 1,
      project_id: "storefront",
      environment: "development",
      processor_name: "analytics-projector",
      processor_version: "v1",
    });
    expect(line).toContain("event_id=abc");
    expect(line).toContain("processor=analytics-projector/v1");
  });
});

describe("postEvent", () => {
  it("returns kind=accepted when the ingester accepts the only event", async () => {
    const fakeFetch = async () =>
      new Response(
        JSON.stringify({ accepted: [{ event_id: "evt_1", status: "accepted" }], rejected: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fakeFetch as unknown as typeof fetch;
    try {
      const result = await postEvent({
        ingesterUrl: "http://localhost",
        apiKey: "polaris_ak_test.secret",
        envelope: { event_id: "evt_1" },
      });
      expect(result.kind).toBe("accepted");
      expect(result.status).toBe(200);
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  it("returns kind=http_error when the status is non-200", async () => {
    const fakeFetch = async () => new Response(JSON.stringify({ error: "bad" }), { status: 401 });
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fakeFetch as unknown as typeof fetch;
    try {
      const result = await postEvent({
        ingesterUrl: "http://localhost",
        apiKey: "polaris_ak_test.secret",
        envelope: { event_id: "evt_1" },
      });
      expect(result.kind).toBe("http_error");
      expect(result.status).toBe(401);
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  it("returns kind=id_mismatch when the response references a different event_id", async () => {
    const fakeFetch = async () =>
      new Response(
        JSON.stringify({ accepted: [{ event_id: "different", status: "accepted" }], rejected: [] }),
        { status: 200 },
      );
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fakeFetch as unknown as typeof fetch;
    try {
      const result = await postEvent({
        ingesterUrl: "http://localhost",
        apiKey: "polaris_ak_test.secret",
        envelope: { event_id: "evt_1" },
      });
      expect(result.kind).toBe("id_mismatch");
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  it("returns kind=partial_reject when the ingester rejected a sibling event", async () => {
    const fakeFetch = async () =>
      new Response(
        JSON.stringify({
          accepted: [{ event_id: "evt_1", status: "accepted" }],
          rejected: [{ event_id: "evt_2", status: "rejected", reason: "schema_validation_failed" }],
        }),
        { status: 200 },
      );
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fakeFetch as unknown as typeof fetch;
    try {
      const result = await postEvent({
        ingesterUrl: "http://localhost",
        apiKey: "polaris_ak_test.secret",
        envelope: { event_id: "evt_1" },
      });
      expect(result.kind).toBe("partial_reject");
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  it("wraps the underlying error in a SmokeError when fetch throws", async () => {
    const fakeFetch = async () => {
      throw new Error("connection refused");
    };
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fakeFetch as unknown as typeof fetch;
    try {
      await expect(
        postEvent({
          ingesterUrl: "http://localhost",
          apiKey: "polaris_ak_test.secret",
          envelope: { event_id: "evt_1" },
        }),
      ).rejects.toBeInstanceOf(SmokeError);
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });
});

describe("pollClickHouseForEvent", () => {
  it("returns the row once analytics_raw sees the event_id", async () => {
    let countCalls = 0;
    const fakeFetch = async (_url: unknown, init?: { body?: string }) => {
      const sql = String(init?.body ?? "");
      if (sql.includes("count(DISTINCT event_id)")) {
        countCalls += 1;
        const seen = countCalls >= 2 ? 1 : 0;
        return new Response(JSON.stringify({ data: [{ seen }] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          data: [
            {
              event_id: "evt_1",
              event: "checkout.started",
              schema_version: 1,
              project_id: "storefront",
              environment: "development",
              processor_name: "analytics-projector",
              processor_version: "v1",
            },
          ],
        }),
        { status: 200 },
      );
    };
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fakeFetch as unknown as typeof fetch;
    try {
      const row = await pollClickHouseForEvent({
        client: { url: "http://localhost:8123", user: "u", password: "p" },
        eventId: "evt_1",
        projectId: "storefront",
        environment: "development",
        timeoutMs: 5_000,
        intervalMs: 1,
        logger: { info: () => undefined, error: () => undefined },
      });
      expect(row.event_id).toBe("evt_1");
      expect(row.processor_name).toBe("analytics-projector");
      expect(row.processor_version).toBe("v1");
      expect(countCalls).toBeGreaterThanOrEqual(2);
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  it("times out with a SmokeError when the event never appears", async () => {
    const fakeFetch = async () =>
      new Response(JSON.stringify({ data: [{ seen: 0 }] }), { status: 200 });
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fakeFetch as unknown as typeof fetch;
    try {
      await expect(
        pollClickHouseForEvent({
          client: { url: "http://localhost:8123", user: "u", password: "p" },
          eventId: "evt_1",
          projectId: "storefront",
          environment: "development",
          timeoutMs: 50,
          intervalMs: 10,
          logger: { info: () => undefined, error: () => undefined },
        }),
      ).rejects.toBeInstanceOf(SmokeError);
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  it("retries transient ClickHouse errors", async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      if (calls < 3) {
        return new Response("read timeout", { status: 504 });
      }
      if (calls === 3) {
        return new Response(JSON.stringify({ data: [{ seen: 1 }] }), { status: 200 });
      }
      // Subsequent SELECT for the full row.
      return new Response(
        JSON.stringify({
          data: [
            {
              event_id: "evt_1",
              event: "checkout.started",
              schema_version: 1,
              project_id: "storefront",
              environment: "development",
              processor_name: "analytics-projector",
              processor_version: "v1",
            },
          ],
        }),
        { status: 200 },
      );
    };
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fakeFetch as unknown as typeof fetch;
    try {
      const row = await pollClickHouseForEvent({
        client: { url: "http://localhost:8123", user: "u", password: "p" },
        eventId: "evt_1",
        projectId: "storefront",
        environment: "development",
        timeoutMs: 5_000,
        intervalMs: 1,
        logger: { info: () => undefined, error: () => undefined },
      });
      expect(row.event_id).toBe("evt_1");
      expect(calls).toBeGreaterThanOrEqual(3);
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });
});

describe("uuidv7", () => {
  it("returns RFC 9562 v7-shaped strings", () => {
    const id = v7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("returns time-ordered ids across different milliseconds", async () => {
    const a = v7();
    // Wait long enough that the 48-bit timestamp prefix differs.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const b = v7();
    // The first 48 bits encode the Unix ms; when they differ, lexicographic
    // comparison of the full string reflects creation order. We compare the
    // timestamp prefix (first 12 hex chars + the two dashes) rather than the
    // whole string because the random tail is, by design, not monotonic
    // within the same ms.
    const prefixA = a.slice(0, 13);
    const prefixB = b.slice(0, 13);
    expect(prefixA.localeCompare(prefixB)).toBeLessThan(0);
  });
});
