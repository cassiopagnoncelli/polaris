// @vitest-environment happy-dom
/**
 * `HttpsTransport` — fetch / sendBeacon transport for the Web SDK.
 *
 * Per `docs/architecture/10-sdk-standards.md`:
 *
 *   - steady-state uses `fetch`
 *   - page-exit uses `navigator.sendBeacon` with `fetch` keepalive fallback
 *   - 4xx (except 408/429) is permanent; 5xx, 408, 429, network errors,
 *     timeouts are retryable
 *   - per-event batch result is parsed from the response body
 *
 * Tests cover:
 *
 *   - steady-mode happy path: parses accepted/rejected from JSON body
 *   - 4xx -> TransportError with retryable=false
 *   - 5xx -> TransportError with retryable=true
 *   - 429 -> retryable
 *   - 408 -> retryable
 *   - permanent vs retryable rejection reason mapping
 *   - urgent mode uses sendBeacon when available
 *   - urgent mode falls back to fetch keepalive when sendBeacon rejects
 */

import { describe, expect, it, vi } from "vitest";

import { HttpsTransport, TransportError } from "../src/transport/https.js";
import type { QueuedEventPayload } from "../src/types.js";

function event(idSuffix: string): QueuedEventPayload {
  return {
    event_id: `00000000-0000-7000-8000-${idSuffix.padStart(12, "0")}`,
    event: "test.event",
    schema_version: 1,
    occurred_at: new Date(1).toISOString(),
    source: { type: "browser", id: "test", sdk: "web", sdk_version: "0.0.0" },
    identity: { anonymous_id: "a", session_id: "s", customer_id: null, device_id: null },
    context: { ip: null, user_agent: null, locale: null, page: null, campaign: null },
    properties: {},
  };
}

function fakeResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("HttpsTransport — constructor", () => {
  it("requires endpoint and apiKey", () => {
    expect(
      () =>
        new HttpsTransport({
          endpoint: "",
          apiKey: "key",
          fetch: globalThis.fetch,
        }),
    ).toThrowError(/endpoint/);
    expect(
      () =>
        new HttpsTransport({
          endpoint: "https://x",
          apiKey: "",
          fetch: globalThis.fetch,
        }),
    ).toThrowError(/apiKey/);
  });
});

describe("HttpsTransport — steady mode", () => {
  it("parses accepted batch results from a 2xx body", async () => {
    const fakeFetch = vi.fn(async () =>
      fakeResponse(
        200,
        JSON.stringify({
          accepted: [{ event_id: event("01").event_id, status: "accepted" }],
          rejected: [],
        }),
      ),
    );
    const transport = new HttpsTransport({
      endpoint: "https://example.invalid/events",
      apiKey: "test-key",
      fetch: fakeFetch,
    });
    const result = await transport.send([event("01")], "steady");
    expect(result.accepted.length).toBe(1);
    expect(result.rejected.length).toBe(0);
    expect(fakeFetch).toHaveBeenCalledOnce();
  });

  it("maps permanent rejection reasons to retryable=false", async () => {
    const id = event("01").event_id;
    const fakeFetch = vi.fn(async () =>
      fakeResponse(
        200,
        JSON.stringify({
          accepted: [],
          rejected: [{ event_id: id, status: "rejected", reason: "schema_validation_failed" }],
        }),
      ),
    );
    const transport = new HttpsTransport({
      endpoint: "https://example.invalid/events",
      apiKey: "test-key",
      fetch: fakeFetch,
    });
    const result = await transport.send([event("01")], "steady");
    expect(result.rejected[0]?.retryable).toBe(false);
  });

  it("maps unknown rejection reasons to retryable=true (transient)", async () => {
    const id = event("01").event_id;
    const fakeFetch = vi.fn(async () =>
      fakeResponse(
        200,
        JSON.stringify({
          accepted: [],
          rejected: [{ event_id: id, status: "rejected", reason: "transient_overload" }],
        }),
      ),
    );
    const transport = new HttpsTransport({
      endpoint: "https://example.invalid/events",
      apiKey: "test-key",
      fetch: fakeFetch,
    });
    const result = await transport.send([event("01")], "steady");
    expect(result.rejected[0]?.retryable).toBe(true);
  });

  it("throws TransportError with retryable=false for 4xx", async () => {
    const fakeFetch = vi.fn(async () => fakeResponse(401, ""));
    const transport = new HttpsTransport({
      endpoint: "https://example.invalid/events",
      apiKey: "test-key",
      fetch: fakeFetch,
    });
    await expect(transport.send([event("01")], "steady")).rejects.toMatchObject({
      name: "TransportError",
      retryable: false,
      status: 401,
    });
  });

  it("throws TransportError with retryable=true for 5xx", async () => {
    const fakeFetch = vi.fn(async () => fakeResponse(503, ""));
    const transport = new HttpsTransport({
      endpoint: "https://example.invalid/events",
      apiKey: "test-key",
      fetch: fakeFetch,
    });
    await expect(transport.send([event("01")], "steady")).rejects.toMatchObject({
      name: "TransportError",
      retryable: true,
      status: 503,
    });
  });

  it("treats 429 as retryable", async () => {
    const fakeFetch = vi.fn(async () => fakeResponse(429, ""));
    const transport = new HttpsTransport({
      endpoint: "https://example.invalid/events",
      apiKey: "test-key",
      fetch: fakeFetch,
    });
    await expect(transport.send([event("01")], "steady")).rejects.toMatchObject({
      retryable: true,
      status: 429,
    });
  });

  it("treats 408 as retryable", async () => {
    const fakeFetch = vi.fn(async () => fakeResponse(408, ""));
    const transport = new HttpsTransport({
      endpoint: "https://example.invalid/events",
      apiKey: "test-key",
      fetch: fakeFetch,
    });
    await expect(transport.send([event("01")], "steady")).rejects.toMatchObject({
      retryable: true,
      status: 408,
    });
  });

  it("wraps network errors in TransportError(retryable=true)", async () => {
    const fakeFetch = vi.fn(async () => {
      throw new TypeError("network failed");
    });
    const transport = new HttpsTransport({
      endpoint: "https://example.invalid/events",
      apiKey: "test-key",
      fetch: fakeFetch,
    });
    await expect(transport.send([event("01")], "steady")).rejects.toMatchObject({
      name: "TransportError",
      retryable: true,
    });
  });

  it("treats events the ingester did not echo as accepted (defensive)", async () => {
    const fakeFetch = vi.fn(async () =>
      fakeResponse(200, JSON.stringify({ accepted: [], rejected: [] })),
    );
    const transport = new HttpsTransport({
      endpoint: "https://example.invalid/events",
      apiKey: "test-key",
      fetch: fakeFetch,
    });
    const result = await transport.send([event("01"), event("02")], "steady");
    expect(result.accepted.length).toBe(2);
  });
});

describe("HttpsTransport — urgent mode", () => {
  it("uses sendBeacon when available and returns optimistic accepts", async () => {
    const fakeBeacon = vi.fn(() => true);
    const fakeFetch = vi.fn();
    const transport = new HttpsTransport({
      endpoint: "https://example.invalid/events",
      apiKey: "test-key",
      fetch: fakeFetch as unknown as typeof fetch,
      sendBeacon: fakeBeacon,
    });
    const result = await transport.send([event("01")], "urgent");
    expect(fakeBeacon).toHaveBeenCalledOnce();
    expect(fakeFetch).not.toHaveBeenCalled();
    expect(result.accepted.length).toBe(1);
  });

  it("falls back to fetch keepalive when sendBeacon refuses", async () => {
    const fakeBeacon = vi.fn(() => false);
    const fakeFetch = vi.fn(async () => fakeResponse(200, ""));
    const transport = new HttpsTransport({
      endpoint: "https://example.invalid/events",
      apiKey: "test-key",
      fetch: fakeFetch,
      sendBeacon: fakeBeacon,
    });
    const result = await transport.send([event("01")], "urgent");
    expect(fakeBeacon).toHaveBeenCalledOnce();
    expect(fakeFetch).toHaveBeenCalledOnce();
    const callArgs = fakeFetch.mock.calls[0];
    const init = callArgs?.[1] as RequestInit | undefined;
    expect(init?.keepalive).toBe(true);
    expect(result.accepted.length).toBe(1);
  });

  it("falls back to fetch keepalive when explicit sendBeacon refuses", async () => {
    // Explicitly passing a sendBeacon that rejects the payload simulates
    // the real-browser scenario where the beacon exists but the payload
    // is too large to queue.
    const fakeFetch = vi.fn(async () => fakeResponse(200, ""));
    const transport = new HttpsTransport({
      endpoint: "https://example.invalid/events",
      apiKey: "test-key",
      fetch: fakeFetch,
      sendBeacon: () => false,
    });
    const result = await transport.send([event("01")], "urgent");
    expect(fakeFetch).toHaveBeenCalledOnce();
    expect(result.accepted.length).toBe(1);
  });
});

describe("HttpsTransport — request shape", () => {
  it("sends the API key in the x-polaris-api-key header (not Authorization)", async () => {
    // The ingester reads only `x-polaris-api-key`; Authorization: Bearer
    // is reserved for the control-plane operator-token flow. The SDK
    // must use the data-plane header or every request gets 401.
    const fakeFetch = vi.fn(async () => fakeResponse(200, ""));
    const transport = new HttpsTransport({
      endpoint: "https://example.invalid/events",
      apiKey: "secret-key",
      fetch: fakeFetch,
    });
    await transport.send([event("01")], "steady");
    const callArgs = fakeFetch.mock.calls[0];
    const init = callArgs?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.["x-polaris-api-key"]).toBe("secret-key");
    expect(headers?.Authorization).toBeUndefined();
  });

  it("posts JSON containing the events", async () => {
    const fakeFetch = vi.fn(async () => fakeResponse(200, ""));
    const transport = new HttpsTransport({
      endpoint: "https://example.invalid/events",
      apiKey: "key",
      fetch: fakeFetch,
    });
    await transport.send([event("01"), event("02")], "steady");
    const callArgs = fakeFetch.mock.calls[0];
    const init = callArgs?.[1] as RequestInit | undefined;
    expect(typeof init?.body).toBe("string");
    const body = JSON.parse(init?.body as string) as { events: unknown[] };
    expect(body.events.length).toBe(2);
  });
});

describe("TransportError", () => {
  it("attaches retryable, status, code fields", () => {
    const err = new TransportError("oops", {
      retryable: true,
      status: 502,
      code: "ECONNRESET",
    });
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(502);
    expect(err.code).toBe("ECONNRESET");
    expect(err.name).toBe("TransportError");
  });
});
