/**
 * Behavioral tests for the ga4 v1 deliverer.
 *
 * The deliverer is the only stage that touches the network. Pinned:
 *
 *   - HTTP 204 (GA4's canonical success response) → accepted
 *   - HTTP 200 (debug endpoint variant)          → accepted
 *   - 408 / 429 / 5xx                            → failed_retryable + matching error_class
 *   - 401 / 403                                  → failed_permanent + error_class='auth'
 *   - other 4xx                                  → failed_permanent + error_class='permanent'
 *   - network / abort                            → failed_retryable + transient / timeout
 *   - URL shape: /mp/collect?measurement_id=&api_secret=
 *   - body wraps mapper payload in { client_id, events: [...] }
 *   - malformed secret                           → failed_permanent + error_class='auth'
 *   - api_secret redacted out of vendor_response_summary
 *
 * @see sync/destinations/ga4/v1/src/deliverer.ts
 */

import { describe, expect, it } from "vitest";

import {
  buildFirebaseAppStreamUrl,
  buildGa4Deliverer,
  buildMeasurementProtocolUrl,
  buildRequestBody,
  classifyRetryableStatus,
  isRetryableStatus,
  parseResolvedSecret,
} from "../src/deliverer.js";

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

describe("buildGa4Deliverer — accepted path", () => {
  it("maps HTTP 204 No Content (GA4's canonical success response) to { kind: 'accepted' }", async () => {
    // GA4 Measurement Protocol returns 204 with an empty body on success.
    // The Response constructor disallows passing a body on 204; we pass
    // `null` and Response infers an empty body to mirror the wire shape.
    const { fetch } = makeFetch(() => new Response(null, { status: 204 }));
    const deliver = buildGa4Deliverer({ fetch, requestTimeoutMs: 5000 });
    const ctx = fixtureDelivererContext();

    const result = await deliver(ctx);
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.vendor_response_code).toBe("204");
    expect(result.vendor_response_summary).toBe("204 No Content");
  });

  it("maps HTTP 200 (debug endpoint variant) to { kind: 'accepted' }", async () => {
    const { fetch } = makeFetch(() => new Response('{"validationMessages":[]}', { status: 200 }));
    const deliver = buildGa4Deliverer({ fetch, requestTimeoutMs: 5000 });
    const ctx = fixtureDelivererContext();

    const result = await deliver(ctx);
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.vendor_response_code).toBe("200");
    expect(result.vendor_response_summary).toContain("validationMessages");
  });

  it("POSTs to <host>/mp/collect with measurement_id + api_secret query string", async () => {
    const { fetch, calls } = makeFetch(() => new Response(null, { status: 204 }));
    const deliver = buildGa4Deliverer({
      fetch,
      requestTimeoutMs: 5000,
      apiHost: "www.google-analytics.test",
    });
    await deliver(fixtureDelivererContext());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    const url = calls[0]?.url ?? "";
    expect(url).toContain("https://www.google-analytics.test/mp/collect?");
    expect(url).toContain("measurement_id=G-TEST123456");
    expect(url).toContain("api_secret=ga4-test-api-secret-xyz123");
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
  });

  it("wraps the mapper payload inside { client_id, events: [payload] }", async () => {
    const { fetch, calls } = makeFetch(() => new Response(null, { status: 204 }));
    const deliver = buildGa4Deliverer({ fetch, requestTimeoutMs: 5000 });
    const ctx = fixtureDelivererContext();
    await deliver(ctx);

    const body = JSON.parse(calls[0]?.body ?? "");
    expect(body.client_id).toBe(ctx.delivery_key);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].name).toBe(ctx.payload.name);
  });
});

describe("buildGa4Deliverer — retryable failures", () => {
  it("HTTP 500 → failed_retryable + transient", async () => {
    const { fetch } = makeFetch(() => new Response("oops", { status: 500 }));
    const deliver = buildGa4Deliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext());
    expect(result.kind).toBe("failed_retryable");
    if (result.kind !== "failed_retryable") return;
    expect(result.error_class).toBe("transient");
    expect(result.vendor_response_code).toBe("500");
  });

  it("HTTP 429 → failed_retryable + rate_limit", async () => {
    const { fetch } = makeFetch(() => new Response("slow", { status: 429 }));
    const deliver = buildGa4Deliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext());
    if (result.kind !== "failed_retryable") throw new Error("expected retryable");
    expect(result.error_class).toBe("rate_limit");
  });

  it("HTTP 408 → failed_retryable + timeout", async () => {
    const { fetch } = makeFetch(() => new Response("timeout", { status: 408 }));
    const deliver = buildGa4Deliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext());
    if (result.kind !== "failed_retryable") throw new Error("expected retryable");
    expect(result.error_class).toBe("timeout");
  });

  it("network error → failed_retryable + transient", async () => {
    const err = new Error("ECONNREFUSED");
    const { fetch } = makeFetch(() => err);
    const deliver = buildGa4Deliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext());
    if (result.kind !== "failed_retryable") throw new Error("expected retryable");
    expect(result.error_class).toBe("transient");
  });

  it("AbortError → failed_retryable + timeout", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    const { fetch } = makeFetch(() => abortErr);
    const deliver = buildGa4Deliverer({ fetch, requestTimeoutMs: 1 });
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
    const deliver = buildGa4Deliverer({ fetch: fetchImpl, requestTimeoutMs: 50 });
    const result = await deliver(fixtureDelivererContext());
    expect(abortObserved).toBe(true);
    if (result.kind !== "failed_retryable") throw new Error("expected retryable");
    expect(result.error_class).toBe("timeout");
  });
});

describe("buildGa4Deliverer — permanent failures", () => {
  it("HTTP 401 → failed_permanent + auth", async () => {
    const { fetch } = makeFetch(() => new Response("nope", { status: 401 }));
    const deliver = buildGa4Deliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext());
    if (result.kind !== "failed_permanent") throw new Error("expected permanent");
    expect(result.error_class).toBe("auth");
  });

  it("HTTP 403 → failed_permanent + auth", async () => {
    const { fetch } = makeFetch(() => new Response("nope", { status: 403 }));
    const deliver = buildGa4Deliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext());
    if (result.kind !== "failed_permanent") throw new Error("expected permanent");
    expect(result.error_class).toBe("auth");
  });

  it("HTTP 400 → failed_permanent + permanent", async () => {
    const { fetch } = makeFetch(() => new Response("bad", { status: 400 }));
    const deliver = buildGa4Deliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext());
    if (result.kind !== "failed_permanent") throw new Error("expected permanent");
    expect(result.error_class).toBe("permanent");
  });

  it("rejects a malformed secret (not JSON, no api_secret) as auth", async () => {
    const { fetch, calls } = makeFetch(() => new Response(null, { status: 204 }));
    const deliver = buildGa4Deliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext({ secret: "not-a-json-blob" }));
    if (result.kind !== "failed_permanent") throw new Error("expected permanent");
    expect(result.error_class).toBe("auth");
    expect(calls).toHaveLength(0);
  });

  it("rejects a JSON secret with missing api_secret as auth", async () => {
    const { fetch, calls } = makeFetch(() => new Response(null, { status: 204 }));
    const deliver = buildGa4Deliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(
      fixtureDelivererContext({ secret: JSON.stringify({ measurement_id: "G-XYZ" }) }),
    );
    if (result.kind !== "failed_permanent") throw new Error("expected permanent");
    expect(result.error_class).toBe("auth");
    expect(calls).toHaveLength(0);
  });

  it("redacts the api_secret if it ever lands in the response body", async () => {
    const secret = "ga4-test-api-secret-xyz123";
    const { fetch } = makeFetch(
      () => new Response(`{"error":"invalid query param: api_secret=${secret}"}`, { status: 400 }),
    );
    const deliver = buildGa4Deliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext());
    if (result.kind !== "failed_permanent") throw new Error("expected permanent");
    expect(result.vendor_response_summary).not.toContain(secret);
    expect(result.vendor_response_summary).toContain("[redacted-api-secret]");
  });
});

describe("parseResolvedSecret", () => {
  it("accepts the canonical { measurement_id, api_secret } JSON", () => {
    expect(
      parseResolvedSecret(JSON.stringify({ measurement_id: "G-XYZ", api_secret: "s1" })),
    ).toEqual({
      measurement_id: "G-XYZ",
      api_secret: "s1",
    });
  });

  it("threads firebase_app_id through when the operator includes it (KCS3ATPC)", () => {
    expect(
      parseResolvedSecret(
        JSON.stringify({
          measurement_id: "G-XYZ",
          api_secret: "s1",
          firebase_app_id: "1:NNN:android:abcdef",
        }),
      ),
    ).toEqual({
      measurement_id: "G-XYZ",
      api_secret: "s1",
      firebase_app_id: "1:NNN:android:abcdef",
    });
  });

  it("treats firebase_app_id='' as absent (operator hasn't rotated yet)", () => {
    expect(
      parseResolvedSecret(
        JSON.stringify({ measurement_id: "G-XYZ", api_secret: "s1", firebase_app_id: "" }),
      ),
    ).toEqual({ measurement_id: "G-XYZ", api_secret: "s1" });
  });

  it("rejects empty + non-JSON + missing-required-field shapes", () => {
    expect(parseResolvedSecret("")).toBeNull();
    expect(parseResolvedSecret("not json")).toBeNull();
    expect(parseResolvedSecret("{not json")).toBeNull();
    expect(parseResolvedSecret(JSON.stringify({ measurement_id: "G-XYZ" }))).toBeNull();
    expect(parseResolvedSecret(JSON.stringify({ api_secret: "s1" }))).toBeNull();
    expect(
      parseResolvedSecret(JSON.stringify({ measurement_id: "", api_secret: "s1" })),
    ).toBeNull();
    expect(
      parseResolvedSecret(JSON.stringify({ measurement_id: "G-XYZ", api_secret: "" })),
    ).toBeNull();
  });
});

describe("buildMeasurementProtocolUrl", () => {
  it("produces a GA4 MP URL with measurement_id and api_secret query params", () => {
    const url = buildMeasurementProtocolUrl("www.google-analytics.com", "G-ABC123", "secret123");
    expect(url).toBe(
      "https://www.google-analytics.com/mp/collect?measurement_id=G-ABC123&api_secret=secret123",
    );
  });

  it("URL-encodes credentials defensively", () => {
    const url = buildMeasurementProtocolUrl(
      "www.google-analytics.com",
      "G-ABC&123",
      "secret with spaces",
    );
    // URLSearchParams encodes & in the value but not the param separator.
    expect(url).toContain("measurement_id=G-ABC%26123");
    expect(url).toContain("api_secret=secret+with+spaces");
  });
});

describe("buildRequestBody", () => {
  it("wraps the per-event payload in { client_id, events: [...] }", () => {
    const ctx = fixtureDelivererContext();
    const body = buildRequestBody(ctx);
    expect(body.client_id).toBe(ctx.delivery_key);
    expect(body.app_instance_id).toBeUndefined();
    expect(body.events).toEqual([ctx.payload]);
  });

  it("flips to { app_instance_id, events: [...] } when the mapper supplied a hint AND the secret carries firebase_app_id (KCS3ATPC)", () => {
    const ctx = fixtureDelivererContext({
      payload: {
        name: "purchase",
        params: { currency: "USD", value: 49.99, transaction_id: "tx_42" },
        app_instance_id: "11111111-2222-3333-4444-555555555555",
      },
    });
    const body = buildRequestBody(ctx, {
      measurement_id: "G-XYZ",
      api_secret: "s1",
      firebase_app_id: "1:NNN:ios:abcdef",
    });
    expect(body.client_id).toBeUndefined();
    expect(body.app_instance_id).toBe("11111111-2222-3333-4444-555555555555");
    // Polaris-internal hint is stripped from the wire event payload.
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).not.toHaveProperty("app_instance_id");
    expect(body.events[0]?.name).toBe("purchase");
  });

  it("stays on the web-stream wrapper when the mapper supplied an app_instance_id but the secret has no firebase_app_id", () => {
    const ctx = fixtureDelivererContext({
      payload: {
        name: "purchase",
        params: { currency: "USD", value: 49.99 },
        app_instance_id: "11111111-2222-3333-4444-555555555555",
      },
    });
    const body = buildRequestBody(ctx, { measurement_id: "G-XYZ", api_secret: "s1" });
    expect(body.client_id).toBe(ctx.delivery_key);
    expect(body.app_instance_id).toBeUndefined();
    // The Polaris-internal hint is still stripped from the wire event payload — operators
    // who haven't rotated their secret get a clean web-stream payload, not a half-routed body.
    expect(body.events[0]).not.toHaveProperty("app_instance_id");
  });
});

describe("buildGa4Deliverer — Firebase app-stream routing (KCS3ATPC)", () => {
  it("POSTs to /mp/collect?firebase_app_id=...&api_secret=... and stamps app_instance_id on the wrapper", async () => {
    const { fetch, calls } = makeFetch(() => new Response(null, { status: 204 }));
    const deliver = buildGa4Deliverer({
      fetch,
      requestTimeoutMs: 5000,
      apiHost: "www.google-analytics.test",
    });
    await deliver(
      fixtureDelivererContext({
        secret: JSON.stringify({
          measurement_id: "G-TEST123456",
          api_secret: "ga4-test-api-secret-xyz123",
          firebase_app_id: "1:NNN:ios:abcdef",
        }),
        payload: {
          name: "purchase",
          params: { currency: "USD", value: 49.99, transaction_id: "tx_42" },
          app_instance_id: "11111111-2222-3333-4444-555555555555",
        },
      }),
    );
    expect(calls).toHaveLength(1);
    const url = calls[0]?.url ?? "";
    expect(url).toContain("https://www.google-analytics.test/mp/collect?");
    expect(url).toContain("firebase_app_id=1%3ANNN%3Aios%3Aabcdef");
    expect(url).toContain("api_secret=ga4-test-api-secret-xyz123");
    expect(url).not.toContain("measurement_id=");
    const body = JSON.parse(calls[0]?.body ?? "");
    expect(body.app_instance_id).toBe("11111111-2222-3333-4444-555555555555");
    expect(body.client_id).toBeUndefined();
    expect(body.events[0].app_instance_id).toBeUndefined();
  });

  it("stays on the web-stream URL when the mapper supplied an app_instance_id but the operator hasn't rotated the secret to add firebase_app_id", async () => {
    const { fetch, calls } = makeFetch(() => new Response(null, { status: 204 }));
    const deliver = buildGa4Deliverer({ fetch, requestTimeoutMs: 5000 });
    await deliver(
      fixtureDelivererContext({
        payload: {
          name: "purchase",
          params: { currency: "USD", value: 49.99 },
          app_instance_id: "11111111-2222-3333-4444-555555555555",
        },
      }),
    );
    const url = calls[0]?.url ?? "";
    expect(url).toContain("measurement_id=G-TEST123456");
    expect(url).not.toContain("firebase_app_id");
    const body = JSON.parse(calls[0]?.body ?? "");
    expect(body.client_id).toBeDefined();
    expect(body.app_instance_id).toBeUndefined();
  });
});

describe("buildFirebaseAppStreamUrl", () => {
  it("produces a GA4 Firebase MP URL with firebase_app_id and api_secret query params", () => {
    const url = buildFirebaseAppStreamUrl(
      "www.google-analytics.com",
      "1:NNN:ios:abcdef",
      "secret123",
    );
    expect(url).toBe(
      "https://www.google-analytics.com/mp/collect?firebase_app_id=1%3ANNN%3Aios%3Aabcdef&api_secret=secret123",
    );
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
    expect(isRetryableStatus(204)).toBe(false);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
  });
});

describe("buildGa4Deliverer — per-project configuration", () => {
  it("a project's api_host overrides the deployment default", async () => {
    // The cutover's whole point: an operator changes one project's host from
    // the admin panel and this delivery follows it, without a redeploy and
    // without affecting any other project.
    const { fetch, calls } = makeFetch(() => new Response(null, { status: 204 }));
    const deliver = buildGa4Deliverer({
      fetch,
      requestTimeoutMs: 5000,
      apiHost: "ga4.deployment-default.test",
    });

    await deliver(fixtureDelivererContext({ projectConfig: { api_host: "ga4.per-project.test" } }));
    expect(calls[0]?.url).toContain("ga4.per-project.test");
  });

  it("falls back to the deployment default when the project sets nothing", async () => {
    // A cold cache or a project with no overrides must behave exactly as it
    // did before the cutover — losing the deployment default here would
    // silently change vendor behaviour mid-batch.
    const { fetch, calls } = makeFetch(() => new Response(null, { status: 204 }));
    const deliver = buildGa4Deliverer({
      fetch,
      requestTimeoutMs: 5000,
      apiHost: "ga4.deployment-default.test",
    });

    await deliver(fixtureDelivererContext({ projectConfig: {} }));
    expect(calls[0]?.url).toContain("ga4.deployment-default.test");
  });

  it("ignores a malformed value rather than failing the delivery", async () => {
    // The value is operator-supplied. Dead-lettering a producer's events over
    // a typo in an unrelated setting is the wrong trade; the deployment
    // default is a safe, predictable fallback.
    const { fetch, calls } = makeFetch(() => new Response(null, { status: 204 }));
    const deliver = buildGa4Deliverer({
      fetch,
      requestTimeoutMs: 5000,
      apiHost: "ga4.deployment-default.test",
    });

    const result = await deliver(
      fixtureDelivererContext({
        projectConfig: { api_host: 12345, request_timeout_ms: "soon" },
      }),
    );
    expect(result.kind).toBe("accepted");
    expect(calls[0]?.url).toContain("ga4.deployment-default.test");
  });

  it("ignores keys it does not declare", async () => {
    // Free-form keys are a designed capability; a strict parse would fail
    // every delivery for that project the moment one appeared.
    const { fetch, calls } = makeFetch(() => new Response(null, { status: 204 }));
    const deliver = buildGa4Deliverer({
      fetch,
      requestTimeoutMs: 5000,
      apiHost: "ga4.deployment-default.test",
    });

    const result = await deliver(
      fixtureDelivererContext({
        projectConfig: { api_host: "ga4.per-project.test", something_unknown: "ignored" },
      }),
    );
    expect(result.kind).toBe("accepted");
    expect(calls[0]?.url).toContain("ga4.per-project.test");
  });
});

describe("buildGa4Deliverer — per-project request_timeout_ms", () => {
  /**
   * A fetch that never settles on its own, so the ONLY thing that ends the
   * call is the deliverer's own AbortController. That makes the assertion
   * about the timeout actually taking effect rather than about how fast the
   * test machine is.
   */
  function hangingFetch(): typeof globalThis.fetch {
    return (async (_input: unknown, init?: { signal?: AbortSignal }) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as typeof globalThis.fetch;
  }

  it("a project's request_timeout_ms overrides the deployment default", async () => {
    const deliver = buildGa4Deliverer({
      fetch: hangingFetch(),
      requestTimeoutMs: 60_000,
      apiHost: "ga4.deployment-default.test",
    });

    const result = await deliver(
      fixtureDelivererContext({ projectConfig: { request_timeout_ms: 5 } }),
    );

    // Without the override this would sit on the 60s deployment default and
    // the test would time out rather than fail — which is the failure mode
    // worth having, since a silently-ignored timeout override is invisible.
    expect(result.kind).toBe("failed_retryable");
    expect(result.kind === "failed_retryable" ? result.error_class : null).toBe("timeout");
  });
});
