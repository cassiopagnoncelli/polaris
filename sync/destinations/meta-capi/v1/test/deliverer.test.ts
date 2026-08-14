/**
 * Behavioral tests for the meta-capi v1 deliverer.
 *
 * The deliverer is the only stage that touches the network. Pinned:
 *
 *   - 2xx                       → accepted
 *   - 408 / 429 / 5xx           → failed_retryable + matching error_class
 *   - 401 / 403                 → failed_permanent + error_class='auth'
 *   - other 4xx                 → failed_permanent + error_class='permanent'
 *   - network / abort           → failed_retryable + transient / timeout
 *   - URL shape carries pixel_id + access_token; access_token never logged
 *   - body wraps mapper payload in { data: [...] }; test_event_code
 *     attached when present in the secret JSON
 *   - malformed secret → failed_permanent + error_class='auth'
 *   - access token redacted out of vendor_response_summary
 *
 * @see sync/destinations/meta-capi/v1/src/deliverer.ts
 */

import { describe, expect, it } from "vitest";

import {
  buildGraphUrl,
  buildMetaCapiDeliverer,
  classifyRetryableStatus,
  isRetryableStatus,
  parseResolvedSecret,
} from "../src/deliverer.js";
import { META_GRAPH_API_VERSION } from "../src/descriptor-identity.js";

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

describe("buildMetaCapiDeliverer — accepted path", () => {
  it("maps HTTP 200 to { kind: 'accepted' }", async () => {
    const { fetch } = makeFetch(
      () => new Response('{"events_received":1,"fbtrace_id":"trace_abc"}', { status: 200 }),
    );
    const deliver = buildMetaCapiDeliverer({ fetch, requestTimeoutMs: 5000 });
    const ctx = fixtureDelivererContext();

    const result = await deliver(ctx);
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.vendor_response_code).toBe("200");
    expect(result.vendor_response_summary).toContain("events_received");
    expect(result.vendor_response_summary).toContain("trace_abc");
  });

  it("POSTs to graph.<host>/<api_version>/<pixel_id>/events with access_token", async () => {
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const deliver = buildMetaCapiDeliverer({
      fetch,
      requestTimeoutMs: 5000,
      graphHost: "graph.facebook.test",
    });
    await deliver(fixtureDelivererContext());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("https://graph.facebook.test/");
    expect(calls[0]?.url).toContain(`/${META_GRAPH_API_VERSION}/1234567890/events`);
    expect(calls[0]?.url).toContain("access_token=");
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
  });

  it("wraps the mapper payload inside { data: [payload] }", async () => {
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const deliver = buildMetaCapiDeliverer({ fetch, requestTimeoutMs: 5000 });
    const ctx = fixtureDelivererContext();
    await deliver(ctx);

    const body = JSON.parse(calls[0]?.body ?? "");
    expect(body.data).toHaveLength(1);
    expect(body.data[0].event_name).toBe(ctx.payload.event_name);
    expect(body.data[0].event_id).toBe(ctx.payload.event_id);
    expect(body.test_event_code).toBeUndefined();
  });

  it("attaches test_event_code from the secret when present", async () => {
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const deliver = buildMetaCapiDeliverer({ fetch, requestTimeoutMs: 5000 });
    const ctx = fixtureDelivererContext({
      secret: JSON.stringify({
        pixel_id: "123",
        access_token: "EAAB-test",
        test_event_code: "TEST123",
      }),
    });
    await deliver(ctx);

    const body = JSON.parse(calls[0]?.body ?? "");
    expect(body.test_event_code).toBe("TEST123");
  });
});

describe("buildMetaCapiDeliverer — retryable failures", () => {
  it("HTTP 500 → failed_retryable + transient", async () => {
    const { fetch } = makeFetch(() => new Response("oops", { status: 500 }));
    const deliver = buildMetaCapiDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext());
    expect(result.kind).toBe("failed_retryable");
    if (result.kind !== "failed_retryable") return;
    expect(result.error_class).toBe("transient");
    expect(result.vendor_response_code).toBe("500");
  });

  it("HTTP 429 → failed_retryable + rate_limit", async () => {
    const { fetch } = makeFetch(() => new Response("slow", { status: 429 }));
    const deliver = buildMetaCapiDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext());
    if (result.kind !== "failed_retryable") throw new Error("expected retryable");
    expect(result.error_class).toBe("rate_limit");
  });

  it("HTTP 408 → failed_retryable + timeout", async () => {
    const { fetch } = makeFetch(() => new Response("timeout", { status: 408 }));
    const deliver = buildMetaCapiDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext());
    if (result.kind !== "failed_retryable") throw new Error("expected retryable");
    expect(result.error_class).toBe("timeout");
  });

  it("network error → failed_retryable + transient", async () => {
    const err = new Error("ECONNREFUSED");
    const { fetch } = makeFetch(() => err);
    const deliver = buildMetaCapiDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext());
    if (result.kind !== "failed_retryable") throw new Error("expected retryable");
    expect(result.error_class).toBe("transient");
  });

  it("AbortError → failed_retryable + timeout", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    const { fetch } = makeFetch(() => abortErr);
    const deliver = buildMetaCapiDeliverer({ fetch, requestTimeoutMs: 1 });
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
    const deliver = buildMetaCapiDeliverer({ fetch: fetchImpl, requestTimeoutMs: 50 });
    const result = await deliver(fixtureDelivererContext());
    expect(abortObserved).toBe(true);
    if (result.kind !== "failed_retryable") throw new Error("expected retryable");
    expect(result.error_class).toBe("timeout");
  });
});

describe("buildMetaCapiDeliverer — permanent failures", () => {
  it("HTTP 401 → failed_permanent + auth", async () => {
    const { fetch } = makeFetch(() => new Response("nope", { status: 401 }));
    const deliver = buildMetaCapiDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext());
    if (result.kind !== "failed_permanent") throw new Error("expected permanent");
    expect(result.error_class).toBe("auth");
  });

  it("HTTP 403 → failed_permanent + auth", async () => {
    const { fetch } = makeFetch(() => new Response("nope", { status: 403 }));
    const deliver = buildMetaCapiDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext());
    if (result.kind !== "failed_permanent") throw new Error("expected permanent");
    expect(result.error_class).toBe("auth");
  });

  it("HTTP 400 → failed_permanent + permanent", async () => {
    const { fetch } = makeFetch(() => new Response("bad", { status: 400 }));
    const deliver = buildMetaCapiDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext());
    if (result.kind !== "failed_permanent") throw new Error("expected permanent");
    expect(result.error_class).toBe("permanent");
  });

  it("rejects a malformed secret (not JSON, no pixel_id) as auth", async () => {
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const deliver = buildMetaCapiDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext({ secret: "not-a-json-blob" }));
    if (result.kind !== "failed_permanent") throw new Error("expected permanent");
    expect(result.error_class).toBe("auth");
    expect(calls).toHaveLength(0);
  });

  it("rejects a JSON secret with missing pixel_id as auth", async () => {
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const deliver = buildMetaCapiDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(
      fixtureDelivererContext({ secret: JSON.stringify({ access_token: "EAAB-token" }) }),
    );
    if (result.kind !== "failed_permanent") throw new Error("expected permanent");
    expect(result.error_class).toBe("auth");
    expect(calls).toHaveLength(0);
  });

  it("redacts the access token if it ever lands in the response body", async () => {
    const token = "EAAB-test-access-token-xyz123";
    const { fetch } = makeFetch(
      () => new Response(`{"error":"invalid url: graph.x/${token}"}`, { status: 400 }),
    );
    const deliver = buildMetaCapiDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext());
    if (result.kind !== "failed_permanent") throw new Error("expected permanent");
    expect(result.vendor_response_summary).not.toContain(token);
    expect(result.vendor_response_summary).toContain("[redacted-access-token]");
  });
});

describe("parseResolvedSecret", () => {
  it("accepts the canonical { pixel_id, access_token } JSON", () => {
    expect(parseResolvedSecret(JSON.stringify({ pixel_id: "p1", access_token: "t1" }))).toEqual({
      pixel_id: "p1",
      access_token: "t1",
    });
  });

  it("accepts an optional test_event_code", () => {
    expect(
      parseResolvedSecret(
        JSON.stringify({ pixel_id: "p1", access_token: "t1", test_event_code: "TEST" }),
      ),
    ).toEqual({ pixel_id: "p1", access_token: "t1", test_event_code: "TEST" });
  });

  it("rejects empty + non-JSON + missing-required-field shapes", () => {
    expect(parseResolvedSecret("")).toBeNull();
    expect(parseResolvedSecret("not json")).toBeNull();
    expect(parseResolvedSecret("{not json")).toBeNull();
    expect(parseResolvedSecret(JSON.stringify({ pixel_id: "p1" }))).toBeNull();
    expect(parseResolvedSecret(JSON.stringify({ access_token: "t1" }))).toBeNull();
    expect(parseResolvedSecret(JSON.stringify({ pixel_id: "", access_token: "t1" }))).toBeNull();
    expect(parseResolvedSecret(JSON.stringify({ pixel_id: "p1", access_token: "" }))).toBeNull();
    expect(
      parseResolvedSecret(
        JSON.stringify({ pixel_id: "p1", access_token: "t1", test_event_code: "" }),
      ),
    ).toBeNull();
  });
});

describe("buildGraphUrl", () => {
  it("produces a Graph API URL with encoded path components", () => {
    const url = buildGraphUrl("graph.facebook.com", "v22.0", "1234567890", "EAAB-token");
    expect(url).toBe("https://graph.facebook.com/v22.0/1234567890/events?access_token=EAAB-token");
  });

  it("URL-encodes special characters in token + pixel_id", () => {
    const url = buildGraphUrl("graph.facebook.com", "v22.0", "with/slash", "with space");
    expect(url).toContain("with%2Fslash");
    expect(url).toContain("with%20space");
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

describe("buildMetaCapiDeliverer — per-project configuration", () => {
  it("a project's graph_host overrides the deployment default", async () => {
    // The cutover's whole point: an operator changes one project's host from
    // the admin panel and this delivery follows it, without a redeploy and
    // without affecting any other project.
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const deliver = buildMetaCapiDeliverer({
      fetch,
      requestTimeoutMs: 5000,
      graphHost: "graph.deployment-default.test",
    });

    await deliver(
      fixtureDelivererContext({ projectConfig: { graph_host: "graph.per-project.test" } }),
    );
    expect(calls[0]?.url).toContain("https://graph.per-project.test/");
  });

  it("falls back to the deployment default when the project sets nothing", async () => {
    // A cold cache or a project with no overrides must behave exactly as it
    // did before the cutover — losing the deployment default here would
    // silently change vendor behaviour mid-batch.
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const deliver = buildMetaCapiDeliverer({
      fetch,
      requestTimeoutMs: 5000,
      graphHost: "graph.deployment-default.test",
    });

    await deliver(fixtureDelivererContext({ projectConfig: {} }));
    expect(calls[0]?.url).toContain("https://graph.deployment-default.test/");
  });

  it("ignores a malformed value rather than failing the delivery", async () => {
    // The value is operator-supplied. Dead-lettering a producer's events over
    // a typo in an unrelated setting is the wrong trade; the deployment
    // default is a safe, predictable fallback.
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const deliver = buildMetaCapiDeliverer({
      fetch,
      requestTimeoutMs: 5000,
      graphHost: "graph.deployment-default.test",
    });

    const result = await deliver(
      fixtureDelivererContext({ projectConfig: { graph_host: 12345, request_timeout_ms: "soon" } }),
    );
    expect(result.kind).toBe("accepted");
    expect(calls[0]?.url).toContain("https://graph.deployment-default.test/");
  });

  it("ignores keys it does not declare", async () => {
    // Free-form keys are a designed capability; a strict parse would fail
    // every delivery for that project the moment one appeared.
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const deliver = buildMetaCapiDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(
      fixtureDelivererContext({
        projectConfig: { graph_host: "graph.kept.test", something_unknown: "ignored" },
      }),
    );
    expect(result.kind).toBe("accepted");
    expect(calls[0]?.url).toContain("https://graph.kept.test/");
  });
});
