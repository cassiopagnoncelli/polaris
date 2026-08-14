/**
 * Behavioral tests for the webhook-sink v1 deliverer.
 *
 * The deliverer is the only stage that touches the network. These tests
 * pin the contract that `docs/architecture/06-destinations.md` declares:
 *
 *   - 2xx                  -> accepted
 *   - 408 / 429 / 5xx      -> failed_retryable + matching error_class
 *   - 401 / 403            -> failed_permanent + error_class='auth'
 *   - other 4xx            -> failed_permanent + error_class='permanent'
 *   - network / abort      -> failed_retryable + error_class transient/timeout
 *   - signing key supplied -> request carries X-Polaris-Signature header
 *   - no signing key       -> request omits X-Polaris-Signature
 *   - http://non-loopback  -> failed_permanent + error_class='policy'
 *   - http://localhost     -> allowed (smoke / dev compose)
 *   - malformed secret     -> failed_permanent + error_class='auth'
 *   - request body         -> matches stamped payload exactly
 *
 * @see consumers/webhook-sink/v1/src/deliverer.ts
 */

import { describe, expect, it } from "vitest";

import {
  buildWebhookDeliverer,
  classifyRetryableStatus,
  enforceTransportPolicy,
  HEADER_DELIVERY_ATTEMPT,
  HEADER_DELIVERY_KEY,
  HEADER_DELIVERY_VENDOR,
  HEADER_SIGNATURE,
  isRetryableStatus,
  parseResolvedSecret,
  signBody,
  verifySignature,
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

describe("buildWebhookDeliverer — accepted path", () => {
  it("maps HTTP 200 to { kind: 'accepted', vendor_response_code: '200' }", async () => {
    const { fetch, calls } = makeFetch(() => new Response("ok", { status: 200 }));
    const deliver = buildWebhookDeliverer({ fetch, requestTimeoutMs: 5000 });
    const ctx = fixtureDelivererContext({
      secret: "https://hooks.example/receiver",
    });

    const result = await deliver(ctx);
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.vendor_response_code).toBe("200");
    expect(result.vendor_response_summary).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://hooks.example/receiver");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
  });

  it("stamps delivery_key + attempt + vendor headers", async () => {
    const { fetch, calls } = makeFetch(() => new Response(null, { status: 204 }));
    const deliver = buildWebhookDeliverer({ fetch, requestTimeoutMs: 5000 });
    const ctx = fixtureDelivererContext({
      secret: "https://hooks.example/receiver",
      delivery_key: "pdk_test_xyz",
      attempt: 3,
    });

    await deliver(ctx);
    const headers = calls[0]?.headers ?? {};
    expect(headers[HEADER_DELIVERY_KEY]).toBe("pdk_test_xyz");
    expect(headers[HEADER_DELIVERY_ATTEMPT]).toBe("3");
    expect(headers[HEADER_DELIVERY_VENDOR]).toBe("webhook");
  });

  it("writes the stamped payload as JSON body and pins version=1", async () => {
    const { fetch, calls } = makeFetch(() => new Response("", { status: 200 }));
    const deliver = buildWebhookDeliverer({
      fetch,
      requestTimeoutMs: 5000,
      now: () => new Date("2026-05-14T12:00:00.000Z"),
    });
    const ctx = fixtureDelivererContext({
      secret: "https://hooks.example/receiver",
      delivery_key: "pdk_stamp_test",
      attempt: 2,
    });

    await deliver(ctx);
    const body = JSON.parse(calls[0]?.body ?? "");
    expect(body.version).toBe(1);
    expect(body.delivery.delivery_key).toBe("pdk_stamp_test");
    expect(body.delivery.attempt).toBe(2);
    expect(body.delivery.sent_at).toBe("2026-05-14T12:00:00.000Z");
    expect(body.delivery.consumer.vendor).toBe("webhook");
    expect(body.event.event_id).toBe("evt_01HZZA0YJK0M2R8D8VYV4QH4XR");
  });
});

describe("buildWebhookDeliverer — signing", () => {
  it("adds X-Polaris-Signature when the secret is a {url,signing_key} JSON", async () => {
    const signingKey = "test_signing_key";
    const { fetch, calls } = makeFetch(() => new Response("", { status: 200 }));
    const deliver = buildWebhookDeliverer({
      fetch,
      requestTimeoutMs: 5000,
      now: () => new Date("2026-05-14T12:00:00.000Z"),
    });
    const ctx = fixtureDelivererContext({
      secret: JSON.stringify({
        url: "https://hooks.example/receiver",
        signing_key: signingKey,
      }),
    });

    await deliver(ctx);
    const signature = calls[0]?.headers[HEADER_SIGNATURE];
    expect(signature).toBeDefined();
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    // The signature must verify against the request body.
    expect(verifySignature(calls[0]?.body ?? "", signingKey, signature ?? "")).toBe(true);
  });

  it("omits X-Polaris-Signature when the secret is just a URL", async () => {
    const { fetch, calls } = makeFetch(() => new Response("", { status: 200 }));
    const deliver = buildWebhookDeliverer({ fetch, requestTimeoutMs: 5000 });
    const ctx = fixtureDelivererContext({ secret: "https://hooks.example/receiver" });

    await deliver(ctx);
    expect(calls[0]?.headers[HEADER_SIGNATURE]).toBeUndefined();
  });

  it("verifySignature returns false on a body the signature wasn't computed over", () => {
    const sig = signBody("hello", "k");
    expect(verifySignature("hello", "k", sig)).toBe(true);
    expect(verifySignature("hellp", "k", sig)).toBe(false);
    expect(verifySignature("hello", "different-key", sig)).toBe(false);
  });
});

describe("buildWebhookDeliverer — retryable failures", () => {
  it("maps HTTP 500 to failed_retryable + error_class='transient'", async () => {
    const { fetch } = makeFetch(() => new Response("nope", { status: 500 }));
    const deliver = buildWebhookDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext({ secret: "https://hooks.example/" }));
    expect(result.kind).toBe("failed_retryable");
    if (result.kind !== "failed_retryable") return;
    expect(result.error_class).toBe("transient");
    expect(result.vendor_response_code).toBe("500");
  });

  it("maps HTTP 429 to failed_retryable + error_class='rate_limit'", async () => {
    const { fetch } = makeFetch(() => new Response("slow down", { status: 429 }));
    const deliver = buildWebhookDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext({ secret: "https://hooks.example/" }));
    expect(result.kind).toBe("failed_retryable");
    if (result.kind !== "failed_retryable") return;
    expect(result.error_class).toBe("rate_limit");
  });

  it("maps HTTP 408 to failed_retryable + error_class='timeout'", async () => {
    const { fetch } = makeFetch(() => new Response("timeout", { status: 408 }));
    const deliver = buildWebhookDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext({ secret: "https://hooks.example/" }));
    expect(result.kind).toBe("failed_retryable");
    if (result.kind !== "failed_retryable") return;
    expect(result.error_class).toBe("timeout");
  });

  it("maps a network/fetch error to failed_retryable + error_class='transient'", async () => {
    const err = new Error("ECONNREFUSED");
    const { fetch } = makeFetch(() => err);
    const deliver = buildWebhookDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext({ secret: "https://hooks.example/" }));
    expect(result.kind).toBe("failed_retryable");
    if (result.kind !== "failed_retryable") return;
    expect(result.error_class).toBe("transient");
    expect(result.vendor_response_summary).toContain("ECONNREFUSED");
  });

  it("maps an AbortError (timeout) to failed_retryable + error_class='timeout'", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    const { fetch } = makeFetch(() => abortErr);
    const deliver = buildWebhookDeliverer({ fetch, requestTimeoutMs: 1 });
    const result = await deliver(fixtureDelivererContext({ secret: "https://hooks.example/" }));
    expect(result.kind).toBe("failed_retryable");
    if (result.kind !== "failed_retryable") return;
    expect(result.error_class).toBe("timeout");
  });

  it("actually fires its setTimeout and aborts the fetch when the receiver hangs", async () => {
    // The previous test mocks `fetch` to throw an AbortError synthetically;
    // it doesn't verify that the deliverer's `setTimeout(controller.abort, ...)`
    // path actually fires. This test plugs in a fetch that NEVER resolves
    // on its own — it only rejects when the AbortController triggers.
    // If the deliverer fails to wire the timeout, the test hangs and the
    // suite's per-test timeout fails it (rather than passing on a false
    // positive). The chosen timeout (50ms) is short enough to keep the
    // suite fast and long enough to avoid scheduler flake on slow CI.
    let abortObserved = false;
    const fetch: typeof globalThis.fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          // The deliverer is contractually required to pass a signal; if it
          // didn't, fail fast rather than hanging.
          reject(new Error("test bug: deliverer did not pass an AbortSignal"));
          return;
        }
        signal.addEventListener("abort", () => {
          abortObserved = true;
          const err = new Error("aborted by deliverer timeout");
          err.name = "AbortError";
          reject(err);
        });
      });

    const deliver = buildWebhookDeliverer({ fetch, requestTimeoutMs: 50 });
    const result = await deliver(fixtureDelivererContext({ secret: "https://hooks.example/" }));

    expect(abortObserved).toBe(true);
    expect(result.kind).toBe("failed_retryable");
    if (result.kind !== "failed_retryable") return;
    expect(result.error_class).toBe("timeout");
  });
});

describe("buildWebhookDeliverer — permanent failures", () => {
  it("maps HTTP 401 to failed_permanent + error_class='auth'", async () => {
    const { fetch } = makeFetch(() => new Response("nope", { status: 401 }));
    const deliver = buildWebhookDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext({ secret: "https://hooks.example/" }));
    expect(result.kind).toBe("failed_permanent");
    if (result.kind !== "failed_permanent") return;
    expect(result.error_class).toBe("auth");
  });

  it("maps HTTP 403 to failed_permanent + error_class='auth'", async () => {
    const { fetch } = makeFetch(() => new Response("nope", { status: 403 }));
    const deliver = buildWebhookDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext({ secret: "https://hooks.example/" }));
    expect(result.kind).toBe("failed_permanent");
    if (result.kind !== "failed_permanent") return;
    expect(result.error_class).toBe("auth");
  });

  it("maps HTTP 400 to failed_permanent + error_class='permanent'", async () => {
    const { fetch } = makeFetch(() => new Response("bad input", { status: 400 }));
    const deliver = buildWebhookDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext({ secret: "https://hooks.example/" }));
    expect(result.kind).toBe("failed_permanent");
    if (result.kind !== "failed_permanent") return;
    expect(result.error_class).toBe("permanent");
  });

  it("rejects http:// non-loopback URLs with failed_permanent + error_class='policy'", async () => {
    const { fetch, calls } = makeFetch(() => new Response("", { status: 200 }));
    const deliver = buildWebhookDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext({ secret: "http://insecure.example/" }));
    expect(result.kind).toBe("failed_permanent");
    if (result.kind !== "failed_permanent") return;
    expect(result.error_class).toBe("policy");
    // Never made the HTTP call.
    expect(calls).toHaveLength(0);
  });

  it("allows http://localhost for smoke / dev compose use", async () => {
    const { fetch, calls } = makeFetch(() => new Response("ok", { status: 200 }));
    const deliver = buildWebhookDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext({ secret: "http://localhost:4001/hook" }));
    expect(result.kind).toBe("accepted");
    expect(calls).toHaveLength(1);
  });

  it("rejects a malformed secret with failed_permanent + error_class='auth'", async () => {
    const { fetch, calls } = makeFetch(() => new Response("", { status: 200 }));
    const deliver = buildWebhookDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(fixtureDelivererContext({ secret: "not-a-url-and-not-json" }));
    expect(result.kind).toBe("failed_permanent");
    if (result.kind !== "failed_permanent") return;
    expect(result.error_class).toBe("auth");
    expect(calls).toHaveLength(0);
  });

  it("rejects a JSON secret with no url field", async () => {
    const { fetch } = makeFetch(() => new Response("", { status: 200 }));
    const deliver = buildWebhookDeliverer({ fetch, requestTimeoutMs: 5000 });
    const result = await deliver(
      fixtureDelivererContext({ secret: JSON.stringify({ signing_key: "k" }) }),
    );
    expect(result.kind).toBe("failed_permanent");
    if (result.kind !== "failed_permanent") return;
    expect(result.error_class).toBe("auth");
  });
});

describe("parseResolvedSecret", () => {
  it("returns { url } for a plain HTTPS URL", () => {
    expect(parseResolvedSecret("https://hooks.example/")).toEqual({
      url: "https://hooks.example/",
    });
  });

  it("returns { url, signingKey } for a JSON envelope", () => {
    expect(parseResolvedSecret(JSON.stringify({ url: "https://x", signing_key: "k" }))).toEqual({
      url: "https://x",
      signingKey: "k",
    });
  });

  it("returns null on empty / whitespace / invalid input", () => {
    expect(parseResolvedSecret("")).toBeNull();
    expect(parseResolvedSecret("   ")).toBeNull();
    expect(parseResolvedSecret("not a url")).toBeNull();
    expect(parseResolvedSecret("{not json")).toBeNull();
    expect(parseResolvedSecret(JSON.stringify({ url: 42 }))).toBeNull();
    expect(parseResolvedSecret(JSON.stringify({ url: "" }))).toBeNull();
    expect(parseResolvedSecret(JSON.stringify({ url: "ftp://x" }))).toBeNull();
    expect(parseResolvedSecret(JSON.stringify({ url: "https://x", signing_key: "" }))).toBeNull();
  });
});

describe("enforceTransportPolicy", () => {
  it("accepts HTTPS URLs", () => {
    expect(enforceTransportPolicy("https://x.example")).toBeNull();
  });

  it("accepts http://localhost and http://127.0.0.1", () => {
    expect(enforceTransportPolicy("http://localhost/")).toBeNull();
    expect(enforceTransportPolicy("http://localhost:4000/")).toBeNull();
    expect(enforceTransportPolicy("http://127.0.0.1:4000/")).toBeNull();
  });

  it("rejects http:// on any other host", () => {
    expect(enforceTransportPolicy("http://x.example")).not.toBeNull();
    expect(enforceTransportPolicy("http://192.168.1.5")).not.toBeNull();
  });

  it("rejects non-http schemes", () => {
    expect(enforceTransportPolicy("ftp://x")).not.toBeNull();
    expect(enforceTransportPolicy("data:,hello")).not.toBeNull();
  });
});

describe("classifyRetryableStatus + isRetryableStatus", () => {
  it("408 -> timeout, 429 -> rate_limit, 5xx -> transient", () => {
    expect(classifyRetryableStatus(408)).toBe("timeout");
    expect(classifyRetryableStatus(429)).toBe("rate_limit");
    expect(classifyRetryableStatus(500)).toBe("transient");
    expect(classifyRetryableStatus(503)).toBe("transient");
  });

  it("isRetryableStatus identifies retryable codes", () => {
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });
});

describe("signBody", () => {
  it("produces a sha256=<hex> string of length 71", () => {
    const sig = signBody("hello", "k");
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(sig.length).toBe(71);
  });

  it("is deterministic for the same (body, key) pair", () => {
    expect(signBody("hello", "k")).toBe(signBody("hello", "k"));
  });

  it("changes when the body or key changes", () => {
    const a = signBody("hello", "k");
    const b = signBody("hellp", "k");
    const c = signBody("hello", "kk");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("buildWebhookDeliverer — per-project request_timeout_ms", () => {
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
    const deliver = buildWebhookDeliverer({
      fetch: hangingFetch(),
      requestTimeoutMs: 60_000,
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
