/**
 * Behavioral tests for the tiktok v1 deliverer.
 *
 * The deliverer is the only stage that touches the network. Pinned:
 *
 *   - 2xx                       → accepted
 *   - 408 / 429 / 5xx           → failed_retryable + matching error_class
 *   - 401 / 403                 → failed_permanent + error_class='auth'
 *   - other 4xx                 → failed_permanent + error_class='permanent'
 *   - network / abort           → failed_retryable + transient / timeout
 *   - URL shape: /open_api/<api_version>/event/track/; access_token never in URL
 *   - Access-Token header carries the credential
 *   - body wraps mapper payload in
 *     { event_source, event_source_id, data: [...], test_event_code? };
 *     test_event_code attached when present in the secret JSON
 *   - malformed secret → failed_permanent + error_class='auth'
 *   - access token redacted out of vendor_response_summary
 *
 * @see consumers/tiktok/v1/src/deliverer.ts
 */

import { describe, expect, it } from "vitest";

import {
  buildEventsApiUrl,
  buildTikTokDeliverer,
  classifyRetryableStatus,
  isRetryableStatus,
  parseResolvedSecret,
} from "../src/deliverer.js";
import { TIKTOK_EVENTS_API_VERSION } from "../src/descriptor-identity.js";

import { fixtureDelivererContext } from "./fixtures/normalized.js";

interface FetchCall {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Record<string, string>;
  readonly body: string;
}

function makeFetch(responseFactory: () => Response | Promise<Response> | Error): {
  fetch: typeof globalThis.fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    const headers: Record<string, string> = {};
    const initHeaders = init?.headers ?? {};
    if (initHeaders instanceof Headers) {
      initHeaders.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
    } else if (Array.isArray(initHeaders)) {
      for (const [k, v] of initHeaders) headers[String(k).toLowerCase()] = String(v);
    } else {
      for (const [k, v] of Object.entries(initHeaders))
        headers[String(k).toLowerCase()] = String(v);
    }
    calls.push({
      url,
      method: init?.method,
      headers,
      body: typeof init?.body === "string" ? init.body : String(init?.body ?? ""),
    });
    const out = responseFactory();
    if (out instanceof Error) throw out;
    return out;
  };
  return { fetch: fetchImpl, calls };
}

describe("buildTikTokDeliverer — accepted path", () => {
  it("maps HTTP 200 to { kind: 'accepted' }", async () => {
    const { fetch } = makeFetch(
      () => new Response('{"code":0,"message":"OK","request_id":"req_abc"}', { status: 200 }),
    );
    const deliver = buildTikTokDeliverer({ fetch, requestTimeoutMs: 5000 });
    const ctx = fixtureDelivererContext();

    const result = await deliver(ctx);
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.vendor_response_code).toBe("200");
    expect(result.vendor_response_summary).toContain("request_id");
    expect(result.vendor_response_summary).toContain("req_abc");
  });

  it("POSTs to business-api.<host>/open_api/<api_version>/event/track/ with Access-Token header", async () => {
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const deliver = buildTikTokDeliverer({
      fetch,
      requestTimeoutMs: 5000,
      apiHost: "business-api.tiktok.test",
    });
    await deliver(fixtureDelivererContext());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(
      `https://business-api.tiktok.test/open_api/${TIKTOK_EVENTS_API_VERSION}/event/track/`,
    );
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(calls[0]?.headers["access-token"]).toBe("TT-test-access-token-xyz123");
  });

  it("never includes the access token in the URL", async () => {
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const deliver = buildTikTokDeliverer({ fetch, requestTimeoutMs: 5000 });
    await deliver(fixtureDelivererContext());
    expect(calls[0]?.url).not.toContain("TT-test-access-token-xyz123");
    expect(calls[0]?.url).not.toContain("access_token=");
  });

  it("wraps the mapper payload inside { event_source, event_source_id, data: [payload] }", async () => {
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const deliver = buildTikTokDeliverer({ fetch, requestTimeoutMs: 5000 });
    const ctx = fixtureDelivererContext();
    await deliver(ctx);

    const body = JSON.parse(calls[0]?.body ?? "");
    expect(body.event_source).toBe("web");
    expect(body.event_source_id).toBe("C9876543210");
    expect(body.data).toHaveLength(1);
    expect(body.data[0].event).toBe(ctx.payload.event);
    expect(body.data[0].event_id).toBe(ctx.payload.event_id);
    expect(body.test_event_code).toBeUndefined();
  });

  it("attaches test_event_code from the secret when present", async () => {
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const deliver = buildTikTokDeliverer({ fetch, requestTimeoutMs: 5000 });
    const ctx = fixtureDelivererContext({
      secret: JSON.stringify({
        access_token: "TT-test",
        pixel_id: "C123",
        test_event_code: "TEST456",
      }),
    });
    await deliver(ctx);

    const body = JSON.parse(calls[0]?.body ?? "");
    expect(body.test_event_code).toBe("TEST456");
  });

  it("stamps event_source='crm' when payload has no page.url (backend-emitted)", async () => {
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const deliver = buildTikTokDeliverer({ fetch, requestTimeoutMs: 5000 });
    const baseCtx = fixtureDelivererContext();
    const ctx = {
      ...baseCtx,
      payload: { ...baseCtx.payload, page: undefined },
    };
    await deliver(ctx);

    const body = JSON.parse(calls[0]?.body ?? "");
    expect(body.event_source).toBe("crm");
  });
});

describe("buildTikTokDeliverer — retryable failures", () => {
  it("HTTP 500 → failed_retryable + transient", async () => {
    const { fetch } = makeFetch(() => new Response("oops", { status: 500 }));
    const deliver = buildTikTokDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext());
    expect(result.kind).toBe("failed_retryable");
    if (result.kind !== "failed_retryable") return;
    expect(result.error_class).toBe("transient");
    expect(result.vendor_response_code).toBe("500");
  });

  it("HTTP 429 → failed_retryable + rate_limit", async () => {
    const { fetch } = makeFetch(() => new Response("slow", { status: 429 }));
    const deliver = buildTikTokDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext());
    if (result.kind !== "failed_retryable") throw new Error("expected retryable");
    expect(result.error_class).toBe("rate_limit");
  });

  it("HTTP 408 → failed_retryable + timeout", async () => {
    const { fetch } = makeFetch(() => new Response("timeout", { status: 408 }));
    const deliver = buildTikTokDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext());
    if (result.kind !== "failed_retryable") throw new Error("expected retryable");
    expect(result.error_class).toBe("timeout");
  });

  it("network error → failed_retryable + transient", async () => {
    const err = new Error("ECONNREFUSED");
    const { fetch } = makeFetch(() => err);
    const deliver = buildTikTokDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext());
    if (result.kind !== "failed_retryable") throw new Error("expected retryable");
    expect(result.error_class).toBe("transient");
  });

  it("AbortError → failed_retryable + timeout", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    const { fetch } = makeFetch(() => abortErr);
    const deliver = buildTikTokDeliverer({ fetch, requestTimeoutMs: 1 });
    const result = await deliver(fixtureDelivererContext());
    if (result.kind !== "failed_retryable") throw new Error("expected retryable");
    expect(result.error_class).toBe("timeout");
  });

  it("fires its setTimeout and aborts a hanging fetch", async () => {
    let abortObserved = false;
    const fetchImpl: typeof globalThis.fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("test bug: no signal"));
          return;
        }
        signal.addEventListener("abort", () => {
          abortObserved = true;
          const err = new Error("aborted by deliverer timeout");
          err.name = "AbortError";
          reject(err);
        });
      });
    const deliver = buildTikTokDeliverer({ fetch: fetchImpl, requestTimeoutMs: 50 });
    const result = await deliver(fixtureDelivererContext());
    expect(abortObserved).toBe(true);
    if (result.kind !== "failed_retryable") throw new Error("expected retryable");
    expect(result.error_class).toBe("timeout");
  });
});

describe("buildTikTokDeliverer — permanent failures", () => {
  it("HTTP 401 → failed_permanent + auth", async () => {
    const { fetch } = makeFetch(() => new Response("nope", { status: 401 }));
    const deliver = buildTikTokDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext());
    if (result.kind !== "failed_permanent") throw new Error("expected permanent");
    expect(result.error_class).toBe("auth");
  });

  it("HTTP 403 → failed_permanent + auth", async () => {
    const { fetch } = makeFetch(() => new Response("nope", { status: 403 }));
    const deliver = buildTikTokDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext());
    if (result.kind !== "failed_permanent") throw new Error("expected permanent");
    expect(result.error_class).toBe("auth");
  });

  it("HTTP 400 → failed_permanent + permanent", async () => {
    const { fetch } = makeFetch(() => new Response("bad", { status: 400 }));
    const deliver = buildTikTokDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext());
    if (result.kind !== "failed_permanent") throw new Error("expected permanent");
    expect(result.error_class).toBe("permanent");
  });

  it("rejects a malformed secret (not JSON, no access_token) as auth", async () => {
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const deliver = buildTikTokDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext({ secret: "not-a-json-blob" }));
    if (result.kind !== "failed_permanent") throw new Error("expected permanent");
    expect(result.error_class).toBe("auth");
    expect(calls).toHaveLength(0);
  });

  it("rejects a JSON secret with missing access_token as auth", async () => {
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const deliver = buildTikTokDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(
      fixtureDelivererContext({ secret: JSON.stringify({ pixel_id: "C123" }) }),
    );
    if (result.kind !== "failed_permanent") throw new Error("expected permanent");
    expect(result.error_class).toBe("auth");
    expect(calls).toHaveLength(0);
  });

  it("redacts the access token if it ever lands in the response body", async () => {
    const token = "TT-test-access-token-xyz123";
    const { fetch } = makeFetch(
      () => new Response(`{"error":"invalid header: Access-Token=${token}"}`, { status: 400 }),
    );
    const deliver = buildTikTokDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext());
    if (result.kind !== "failed_permanent") throw new Error("expected permanent");
    expect(result.vendor_response_summary).not.toContain(token);
    expect(result.vendor_response_summary).toContain("[redacted-access-token]");
  });
});

describe("parseResolvedSecret", () => {
  it("accepts the canonical { access_token, pixel_id } JSON", () => {
    expect(parseResolvedSecret(JSON.stringify({ access_token: "t1", pixel_id: "p1" }))).toEqual({
      access_token: "t1",
      pixel_id: "p1",
    });
  });

  it("accepts an optional test_event_code", () => {
    expect(
      parseResolvedSecret(
        JSON.stringify({ access_token: "t1", pixel_id: "p1", test_event_code: "TEST" }),
      ),
    ).toEqual({ access_token: "t1", pixel_id: "p1", test_event_code: "TEST" });
  });

  it("rejects empty + non-JSON + missing-required-field shapes", () => {
    expect(parseResolvedSecret("")).toBeNull();
    expect(parseResolvedSecret("not json")).toBeNull();
    expect(parseResolvedSecret("{not json")).toBeNull();
    expect(parseResolvedSecret(JSON.stringify({ access_token: "t1" }))).toBeNull();
    expect(parseResolvedSecret(JSON.stringify({ pixel_id: "p1" }))).toBeNull();
    expect(parseResolvedSecret(JSON.stringify({ access_token: "", pixel_id: "p1" }))).toBeNull();
    expect(parseResolvedSecret(JSON.stringify({ access_token: "t1", pixel_id: "" }))).toBeNull();
    expect(
      parseResolvedSecret(
        JSON.stringify({ access_token: "t1", pixel_id: "p1", test_event_code: "" }),
      ),
    ).toBeNull();
  });
});

describe("buildEventsApiUrl", () => {
  it("produces a TikTok Events API URL with trailing slash on /event/track/", () => {
    const url = buildEventsApiUrl("business-api.tiktok.com", "v1.3");
    expect(url).toBe("https://business-api.tiktok.com/open_api/v1.3/event/track/");
  });

  it("honours the api_version literal as-is (no encoding)", () => {
    const url = buildEventsApiUrl("business-api.tiktok.com", "v2.0");
    expect(url).toBe("https://business-api.tiktok.com/open_api/v2.0/event/track/");
  });
});

describe("classifyRetryableStatus + isRetryableStatus", () => {
  it("408 → timeout, 429 → rate_limit, 5xx → transient", () => {
    expect(classifyRetryableStatus(408)).toBe("timeout");
    expect(classifyRetryableStatus(429)).toBe("rate_limit");
    expect(classifyRetryableStatus(500)).toBe("transient");
    expect(classifyRetryableStatus(503)).toBe("transient");
  });

  it("isRetryableStatus identifies retryable codes", () => {
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
  });
});
