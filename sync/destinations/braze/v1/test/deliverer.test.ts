/**
 * Behavioral tests for the braze v1 deliverer.
 *
 * The deliverer is the only stage that touches the network. Pinned:
 *
 *   - 2xx                       → accepted
 *   - 408 / 429 / 5xx           → failed_retryable + matching error_class
 *   - 401 / 403                 → failed_permanent + error_class='auth'
 *   - other 4xx                 → failed_permanent + error_class='permanent'
 *   - network / abort           → failed_retryable + transient / timeout
 *   - URL shape: rest.<instance>.braze.com/users/track; api_key never in URL
 *   - Authorization: Bearer <api_key> header carries the credential
 *   - body is the BrazePayload shape directly (no wrapper)
 *   - malformed secret → failed_permanent + error_class='auth'
 *   - api_key redacted out of vendor_response_summary
 *   - {instance} substitution in host template
 *
 * @see sync/destinations/braze/v1/src/deliverer.ts
 */

import { describe, expect, it } from "vitest";

import {
  buildBrazeDeliverer,
  buildUsersTrackUrl,
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

describe("buildBrazeDeliverer — accepted path", () => {
  it("maps HTTP 200 to { kind: 'accepted' }", async () => {
    const { fetch } = makeFetch(() => new Response('{"message":"success"}', { status: 200 }));
    const deliver = buildBrazeDeliverer({ fetch, requestTimeoutMs: 5000 });
    const ctx = fixtureDelivererContext();

    const result = await deliver(ctx);
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.vendor_response_code).toBe("200");
    expect(result.vendor_response_summary).toContain("success");
  });

  it("POSTs to rest.<instance>.braze.com/users/track with Authorization: Bearer header", async () => {
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const deliver = buildBrazeDeliverer({
      fetch,
      requestTimeoutMs: 5000,
      apiHost: "rest.{instance}.braze.test",
    });
    await deliver(fixtureDelivererContext());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://rest.iad-01.braze.test/users/track");
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(calls[0]?.headers["authorization"]).toBe("Bearer br-test-api-key-xyz123456");
  });

  it("never includes the api_key in the URL", async () => {
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const deliver = buildBrazeDeliverer({ fetch, requestTimeoutMs: 5000 });
    await deliver(fixtureDelivererContext());
    expect(calls[0]?.url).not.toContain("br-test-api-key-xyz123456");
    expect(calls[0]?.url).not.toContain("api_key=");
  });

  it("ships the mapper payload directly as the wire body (no wrapper)", async () => {
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const deliver = buildBrazeDeliverer({ fetch, requestTimeoutMs: 5000 });
    const ctx = fixtureDelivererContext();
    await deliver(ctx);

    const body = JSON.parse(calls[0]?.body ?? "");
    expect(body.events).toHaveLength(1);
    expect(body.events[0].external_id).toBe("cust_12345");
    expect(body.events[0].name).toBe("checkout_started");
    expect(body.events[0].time).toBe("2026-05-14T12:00:00.000Z");
    expect(body.attributes).toBeUndefined();
    expect(body.purchases).toBeUndefined();
  });

  it("substitutes {instance} into the host template", async () => {
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const deliver = buildBrazeDeliverer({
      fetch,
      requestTimeoutMs: 5000,
      apiHost: "rest.{instance}.braze.test",
    });
    await deliver(
      fixtureDelivererContext({
        secret: JSON.stringify({ instance: "eu-02", api_key: "key12345678" }),
      }),
    );
    expect(calls[0]?.url).toBe("https://rest.eu-02.braze.test/users/track");
  });

  it("passes the api host through verbatim when no {instance} literal is present", async () => {
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const deliver = buildBrazeDeliverer({
      fetch,
      requestTimeoutMs: 5000,
      apiHost: "braze-mock.test",
    });
    await deliver(fixtureDelivererContext());
    expect(calls[0]?.url).toBe("https://braze-mock.test/users/track");
  });
});

describe("buildBrazeDeliverer — retryable failures", () => {
  it("HTTP 500 → failed_retryable + transient", async () => {
    const { fetch } = makeFetch(() => new Response("oops", { status: 500 }));
    const deliver = buildBrazeDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext());
    expect(result.kind).toBe("failed_retryable");
    if (result.kind !== "failed_retryable") return;
    expect(result.error_class).toBe("transient");
    expect(result.vendor_response_code).toBe("500");
  });

  it("HTTP 429 → failed_retryable + rate_limit", async () => {
    const { fetch } = makeFetch(() => new Response("slow", { status: 429 }));
    const deliver = buildBrazeDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext());
    if (result.kind !== "failed_retryable") throw new Error("expected retryable");
    expect(result.error_class).toBe("rate_limit");
  });

  it("HTTP 408 → failed_retryable + timeout", async () => {
    const { fetch } = makeFetch(() => new Response("timeout", { status: 408 }));
    const deliver = buildBrazeDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext());
    if (result.kind !== "failed_retryable") throw new Error("expected retryable");
    expect(result.error_class).toBe("timeout");
  });

  it("network error → failed_retryable + transient", async () => {
    const err = new Error("ECONNREFUSED");
    const { fetch } = makeFetch(() => err);
    const deliver = buildBrazeDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext());
    if (result.kind !== "failed_retryable") throw new Error("expected retryable");
    expect(result.error_class).toBe("transient");
  });

  it("AbortError → failed_retryable + timeout", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    const { fetch } = makeFetch(() => abortErr);
    const deliver = buildBrazeDeliverer({ fetch, requestTimeoutMs: 1 });
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
    const deliver = buildBrazeDeliverer({ fetch: fetchImpl, requestTimeoutMs: 50 });
    const result = await deliver(fixtureDelivererContext());
    expect(abortObserved).toBe(true);
    if (result.kind !== "failed_retryable") throw new Error("expected retryable");
    expect(result.error_class).toBe("timeout");
  });
});

describe("buildBrazeDeliverer — permanent failures", () => {
  it("HTTP 401 → failed_permanent + auth", async () => {
    const { fetch } = makeFetch(() => new Response("nope", { status: 401 }));
    const deliver = buildBrazeDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext());
    if (result.kind !== "failed_permanent") throw new Error("expected permanent");
    expect(result.error_class).toBe("auth");
  });

  it("HTTP 403 → failed_permanent + auth", async () => {
    const { fetch } = makeFetch(() => new Response("nope", { status: 403 }));
    const deliver = buildBrazeDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext());
    if (result.kind !== "failed_permanent") throw new Error("expected permanent");
    expect(result.error_class).toBe("auth");
  });

  it("HTTP 400 → failed_permanent + permanent", async () => {
    const { fetch } = makeFetch(() => new Response("bad", { status: 400 }));
    const deliver = buildBrazeDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext());
    if (result.kind !== "failed_permanent") throw new Error("expected permanent");
    expect(result.error_class).toBe("permanent");
  });

  it("rejects a malformed secret (not JSON) as auth", async () => {
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const deliver = buildBrazeDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext({ secret: "not-a-json-blob" }));
    if (result.kind !== "failed_permanent") throw new Error("expected permanent");
    expect(result.error_class).toBe("auth");
    expect(calls).toHaveLength(0);
  });

  it("rejects a JSON secret with missing api_key as auth", async () => {
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const deliver = buildBrazeDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(
      fixtureDelivererContext({ secret: JSON.stringify({ instance: "iad-01" }) }),
    );
    if (result.kind !== "failed_permanent") throw new Error("expected permanent");
    expect(result.error_class).toBe("auth");
    expect(calls).toHaveLength(0);
  });

  it("rejects a JSON secret with missing instance as auth", async () => {
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const deliver = buildBrazeDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(
      fixtureDelivererContext({ secret: JSON.stringify({ api_key: "k123456789" }) }),
    );
    if (result.kind !== "failed_permanent") throw new Error("expected permanent");
    expect(result.error_class).toBe("auth");
    expect(calls).toHaveLength(0);
  });

  it("rejects an obviously-bad instance slug as auth (defense against typos)", async () => {
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const deliver = buildBrazeDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(
      fixtureDelivererContext({
        secret: JSON.stringify({ instance: "iad-01.evil/path", api_key: "k123456789" }),
      }),
    );
    if (result.kind !== "failed_permanent") throw new Error("expected permanent");
    expect(result.error_class).toBe("auth");
    expect(calls).toHaveLength(0);
  });

  it("redacts the api_key if it ever lands in the response body", async () => {
    const apiKey = "br-test-api-key-xyz123456";
    const { fetch } = makeFetch(
      () => new Response(`{"error":"bad auth header: Bearer ${apiKey}"}`, { status: 400 }),
    );
    const deliver = buildBrazeDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext());
    if (result.kind !== "failed_permanent") throw new Error("expected permanent");
    expect(result.vendor_response_summary).not.toContain(apiKey);
    expect(result.vendor_response_summary).toContain("[redacted-api-key]");
  });
});

describe("parseResolvedSecret", () => {
  it("accepts the canonical { instance, api_key } JSON", () => {
    expect(parseResolvedSecret(JSON.stringify({ instance: "iad-01", api_key: "k1" }))).toEqual({
      instance: "iad-01",
      api_key: "k1",
    });
  });

  it("accepts a variety of region slugs", () => {
    for (const slug of ["iad-01", "iad-02", "iad-03", "eu-01", "eu-02", "us-04"]) {
      expect(parseResolvedSecret(JSON.stringify({ instance: slug, api_key: "k1" }))).toEqual({
        instance: slug,
        api_key: "k1",
      });
    }
  });

  it("rejects empty + non-JSON + missing-required-field shapes", () => {
    expect(parseResolvedSecret("")).toBeNull();
    expect(parseResolvedSecret("not json")).toBeNull();
    expect(parseResolvedSecret("{not json")).toBeNull();
    expect(parseResolvedSecret(JSON.stringify({ instance: "iad-01" }))).toBeNull();
    expect(parseResolvedSecret(JSON.stringify({ api_key: "k1" }))).toBeNull();
    expect(parseResolvedSecret(JSON.stringify({ instance: "", api_key: "k1" }))).toBeNull();
    expect(parseResolvedSecret(JSON.stringify({ instance: "iad-01", api_key: "" }))).toBeNull();
  });

  it("rejects obviously-bad instance slugs (uppercase, dots, slashes, whitespace)", () => {
    expect(parseResolvedSecret(JSON.stringify({ instance: "IAD-01", api_key: "k1" }))).toBeNull();
    expect(
      parseResolvedSecret(JSON.stringify({ instance: "iad-01.evil", api_key: "k1" })),
    ).toBeNull();
    expect(parseResolvedSecret(JSON.stringify({ instance: "iad-01/x", api_key: "k1" }))).toBeNull();
    expect(parseResolvedSecret(JSON.stringify({ instance: "iad 01", api_key: "k1" }))).toBeNull();
  });
});

describe("buildUsersTrackUrl", () => {
  it("produces a Braze REST URL with /users/track and {instance} substitution", () => {
    const url = buildUsersTrackUrl("rest.{instance}.braze.com", "iad-01");
    expect(url).toBe("https://rest.iad-01.braze.com/users/track");
  });

  it("passes the host through when no {instance} literal is present", () => {
    const url = buildUsersTrackUrl("braze-mock.test", "iad-01");
    expect(url).toBe("https://braze-mock.test/users/track");
  });

  it("substitutes every {instance} occurrence (defensive)", () => {
    // Only the first occurrence per the docs; this test pins the
    // observed behavior of `replace` (single replacement).
    const url = buildUsersTrackUrl("{instance}.rest.{instance}.braze.com", "eu-01");
    expect(url).toBe("https://eu-01.rest.{instance}.braze.com/users/track");
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

describe("buildBrazeDeliverer — per-project configuration", () => {
  it("a project's api_host overrides the deployment default", async () => {
    // The cutover's whole point: an operator changes one project's host from
    // the admin panel and this delivery follows it, without a redeploy and
    // without affecting any other project.
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const deliver = buildBrazeDeliverer({
      fetch,
      requestTimeoutMs: 5000,
      apiHost: "rest.{instance}.deployment-default.test",
    });

    await deliver(
      fixtureDelivererContext({ projectConfig: { api_host: "rest.{instance}.per-project.test" } }),
    );
    expect(calls[0]?.url).toContain("rest.iad-01.per-project.test");
  });

  it("falls back to the deployment default when the project sets nothing", async () => {
    // A cold cache or a project with no overrides must behave exactly as it
    // did before the cutover — losing the deployment default here would
    // silently change vendor behaviour mid-batch.
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const deliver = buildBrazeDeliverer({
      fetch,
      requestTimeoutMs: 5000,
      apiHost: "rest.{instance}.deployment-default.test",
    });

    await deliver(fixtureDelivererContext({ projectConfig: {} }));
    expect(calls[0]?.url).toContain("rest.iad-01.deployment-default.test");
  });

  it("ignores a malformed value rather than failing the delivery", async () => {
    // The value is operator-supplied. Dead-lettering a producer's events over
    // a typo in an unrelated setting is the wrong trade; the deployment
    // default is a safe, predictable fallback.
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const deliver = buildBrazeDeliverer({
      fetch,
      requestTimeoutMs: 5000,
      apiHost: "rest.{instance}.deployment-default.test",
    });

    const result = await deliver(
      fixtureDelivererContext({
        projectConfig: { api_host: 12345, request_timeout_ms: "soon" },
      }),
    );
    expect(result.kind).toBe("accepted");
    expect(calls[0]?.url).toContain("rest.iad-01.deployment-default.test");
  });

  it("ignores keys it does not declare", async () => {
    // Free-form keys are a designed capability; a strict parse would fail
    // every delivery for that project the moment one appeared.
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const deliver = buildBrazeDeliverer({
      fetch,
      requestTimeoutMs: 5000,
      apiHost: "rest.{instance}.deployment-default.test",
    });

    const result = await deliver(
      fixtureDelivererContext({
        projectConfig: {
          api_host: "rest.{instance}.per-project.test",
          something_unknown: "ignored",
        },
      }),
    );
    expect(result.kind).toBe("accepted");
    expect(calls[0]?.url).toContain("rest.iad-01.per-project.test");
  });
});
