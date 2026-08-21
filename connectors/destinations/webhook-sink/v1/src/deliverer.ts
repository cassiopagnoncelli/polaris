/**
 * Webhook-sink v1 deliverer.
 *
 * Per `docs/architecture/06-destinations.md`, the deliverer is the only
 * stage that talks to the network. The shape of the call here is:
 *
 *   1. Resolve the receiver config from the runtime-supplied secret.
 *      The secret is either:
 *        - a URL literal (string starts with `https://` or `http://`)
 *          -> no signing; the secret IS the target URL.
 *        - a JSON object `{ "url": "...", "signing_key": "..." }`
 *          -> POST to `url` with `X-Polaris-Signature: sha256=<hex>`.
 *      Any other shape is `failed_permanent` (`error_class: 'auth'`)
 *      because the runtime cannot deliver without a target.
 *
 *   2. Stamp the runtime-supplied `delivery.*` slots onto the mapper's
 *      payload (the mapper leaves placeholders; the deliverer authoritative).
 *
 *   3. JSON-serialize the payload, then HMAC-SHA256 sign the body if a
 *      signing key is present.
 *
 *   4. POST with a per-attempt timeout (default 5s, configurable per
 *      service via `POLARIS_WEBHOOK_SINK_REQUEST_TIMEOUT_MS`).
 *
 *   5. Map the HTTP response to the runtime's outcome enum:
 *        - 2xx                    -> accepted
 *        - 408, 429, 5xx          -> failed_retryable (transient)
 *        - other 4xx              -> failed_permanent (permanent)
 *        - network / abort error  -> failed_retryable (transient)
 *
 *   6. Truncate the response body to a label-safe summary for the
 *      `vendor_response_summary` column. The runtime separately
 *      `truncateSummary`s its persisted value; we summarize a body
 *      sample (first 200 chars + ellipsis on overflow) here so the
 *      receiver-side hint survives.
 *
 * The deliverer does NOT throw on HTTP / network failures; it catches and
 * returns a typed `DelivererResult` so the runtime's metrics + records
 * carry the right outcome. A `throw` from this function is treated by the
 * runtime as a transient programmer bug.
 *
 * In v1 the deliverer accepts http://localhost URLs to support the
 * smoke / dev compose; any other plain-http URL is `failed_permanent`
 * with `error_class: 'policy'` because production webhook delivery
 * must go over TLS.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Deliverer, DelivererContext, DelivererResult } from "@polaris/delivery-destinations";
import { stampDelivery } from "./mapper.js";
import { parseWebhookSinkProjectConfig } from "./project-config.js";
import type { ResolvedWebhookConfig, WebhookPayload } from "./types.js";

/** Public HTTP header names the deliverer stamps onto every request. */
export const HEADER_SIGNATURE = "x-polaris-signature";
export const HEADER_DELIVERY_KEY = "x-polaris-delivery-key";
export const HEADER_DELIVERY_ATTEMPT = "x-polaris-delivery-attempt";
export const HEADER_DELIVERY_VENDOR = "x-polaris-vendor";
export const HEADER_DELIVERY_CONSUMER_VERSION = "x-polaris-consumer-version";

/**
 * Options accepted by `buildWebhookDeliverer`.
 *
 * Tests inject a fake `fetch` (and an explicit `now`) to drive the
 * deliverer deterministically; production wiring passes `globalThis.fetch`
 * and `() => new Date()`.
 */
export interface BuildDelivererOptions {
  /** `fetch`-compatible implementation. Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Override `() => new Date()` for deterministic tests. */
  readonly now?: () => Date;
  /** Per-attempt request timeout in milliseconds. */
  readonly requestTimeoutMs: number;
}

/**
 * Build a `Deliverer<WebhookPayload>` bound to a `fetch` + timeout +
 * clock. The returned function is the contract `DestinationDescriptor`
 * hands to the runtime.
 */
export function buildWebhookDeliverer(options: BuildDelivererOptions): Deliverer<WebhookPayload> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  // Deployment default. Overridable per project; a project that sets nothing
  // gets exactly this, which is what POLARIS_WEBHOOK_SINK_* meant.
  const defaultTimeoutMs = options.requestTimeoutMs;

  return async function deliver(
    context: DelivererContext<WebhookPayload>,
  ): Promise<DelivererResult> {
    // 0. Per-project overrides. Parsed per delivery rather than per batch
    //    because the runtime hands the slice in on the context; the parse is a
    //    Zod safeParse over one key, and correctness here is worth more than
    //    the microseconds — a batch-level cache would have to be invalidated
    //    on the same signal the store already handles.
    const projectConfig = parseWebhookSinkProjectConfig(context.projectConfig);
    const timeoutMs = projectConfig.request_timeout_ms ?? defaultTimeoutMs;

    // 1. Resolve receiver config from the secret.
    const config = parseResolvedSecret(context.secret);
    if (config === null) {
      return {
        kind: "failed_permanent",
        error_class: "auth",
        vendor_response_summary: "secret value did not resolve to a URL or {url,signing_key} JSON",
      };
    }

    // 2. Enforce TLS for non-loopback targets. Localhost over plain HTTP
    // is permitted for the dev compose; anything else MUST be HTTPS.
    const tlsCheck = enforceTransportPolicy(config.url);
    if (tlsCheck !== null) {
      return {
        kind: "failed_permanent",
        error_class: "policy",
        vendor_response_summary: tlsCheck,
      };
    }

    // 3. Stamp authoritative delivery metadata.
    const sentAt = now().toISOString();
    const wirePayload = stampDelivery(context.payload, {
      delivery_key: context.delivery_key,
      attempt: context.attempt,
      sent_at: sentAt,
    });

    const body = JSON.stringify(wirePayload);

    // 4. Build headers; sign body if a signing key is present.
    const headers: Record<string, string> = {
      "content-type": "application/json",
      [HEADER_DELIVERY_KEY]: context.delivery_key,
      [HEADER_DELIVERY_ATTEMPT]: String(context.attempt),
      [HEADER_DELIVERY_VENDOR]: wirePayload.delivery.consumer.vendor,
      [HEADER_DELIVERY_CONSUMER_VERSION]: wirePayload.delivery.consumer.consumer_version,
    };
    if (config.signingKey !== undefined) {
      headers[HEADER_SIGNATURE] = signBody(body, config.signingKey);
    }

    // 5. POST with per-attempt timeout. AbortController fires on timeout;
    //    fetch raises an AbortError we map to failed_retryable.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(config.url, {
        method: "POST",
        body,
        headers,
        signal: controller.signal,
      });
    } catch (err) {
      // AbortError, DNS failure, ECONNREFUSED, TLS error — all transient
      // from the receiver's perspective. The runtime re-throws on
      // failed_retryable so KafkaJS retries; the operator can flip the
      // destination off if the failure is persistent.
      return {
        kind: "failed_retryable",
        error_class: classifyNetworkError(err),
        vendor_response_summary: summarizeError(err),
      };
    } finally {
      clearTimeout(timer);
    }

    // 6. Read response body for the summary (best-effort; we cap the
    //    payload size we read to avoid pulling megabytes into memory).
    const responseSummary = await readSummary(response);
    const code = String(response.status);

    if (response.status >= 200 && response.status < 300) {
      return {
        kind: "accepted",
        vendor_response_code: code,
        vendor_response_summary: responseSummary,
      };
    }
    if (isRetryableStatus(response.status)) {
      return {
        kind: "failed_retryable",
        error_class: classifyRetryableStatus(response.status),
        vendor_response_code: code,
        vendor_response_summary: responseSummary,
      };
    }
    // 4xx (non-408, non-429) is permanent. Auth-like statuses get
    // `error_class: 'auth'` for DLQ filtering convenience; everything
    // else uses `permanent`.
    return {
      kind: "failed_permanent",
      error_class: response.status === 401 || response.status === 403 ? "auth" : "permanent",
      vendor_response_code: code,
      vendor_response_summary: responseSummary,
    };
  };
}

// ---------------------------------------------------------------------------
// Secret resolution
// ---------------------------------------------------------------------------

/**
 * Parse the resolved secret into a `ResolvedWebhookConfig`. Returns
 * `null` if the shape is not recognised. Public so tests + the future
 * descriptor wiring can share the validation.
 */
export function parseResolvedSecret(secret: string): ResolvedWebhookConfig | null {
  const trimmed = secret.trim();
  if (trimmed.length === 0) return null;

  // URL literal — most common shape.
  if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
    return { url: trimmed };
  }

  // JSON object shape: { "url": "...", "signing_key": "..." }
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    const url = obj["url"];
    const signingKey = obj["signing_key"];
    if (typeof url !== "string" || url.length === 0) return null;
    if (!url.startsWith("https://") && !url.startsWith("http://")) return null;
    if (signingKey === undefined || signingKey === null) {
      return { url };
    }
    if (typeof signingKey !== "string" || signingKey.length === 0) return null;
    return { url, signingKey };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Transport / signature helpers
// ---------------------------------------------------------------------------

/**
 * Allow `http://localhost[:port]` or `http://127.0.0.1[:port]`; reject any
 * other plain-HTTP URL. Returns a reason string on rejection, `null` on
 * accept.
 */
export function enforceTransportPolicy(url: string): string | null {
  if (url.startsWith("https://")) return null;
  if (!url.startsWith("http://")) return "url scheme is not http(s)";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "url is not parseable";
  }
  const host = parsed.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return null;
  return "plain http is not allowed for non-loopback receivers";
}

/**
 * Compute the `X-Polaris-Signature` header value over the request body.
 * The format is `sha256=<lowercase hex>` to match the convention used by
 * GitHub, Slack, and the majority of webhook receivers.
 */
export function signBody(body: string, signingKey: string): string {
  const hmac = createHmac("sha256", signingKey);
  hmac.update(body);
  return `sha256=${hmac.digest("hex")}`;
}

/**
 * Constant-time signature comparison helper. Exposed for receivers + tests;
 * the deliverer itself does not verify (it only signs).
 */
export function verifySignature(body: string, signingKey: string, signature: string): boolean {
  const expected = signBody(body, signingKey);
  // `timingSafeEqual` throws on different lengths; pad to the max.
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// HTTP status mapping
// ---------------------------------------------------------------------------

/**
 * Status codes the runtime should retry. 408 = request timeout; 429 = rate
 * limit; 5xx = server error.
 */
export function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return false;
}

/**
 * Map a retryable status into the runtime's `error_class` enum. 408 maps
 * to `timeout`, 429 to `rate_limit`, 5xx to `transient`. The runtime
 * surfaces this label on `delivery_records.error_class` for dashboards
 * and DLQ filtering.
 */
export function classifyRetryableStatus(status: number): "timeout" | "rate_limit" | "transient" {
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limit";
  return "transient";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RESPONSE_SUMMARY_MAX_CHARS = 200;
const RESPONSE_SUMMARY_MAX_BYTES = 4096;

async function readSummary(response: Response): Promise<string> {
  try {
    // Cap the read to a small slice — receivers may emit large error pages
    // we shouldn't drag through the logs.
    const buffer = await response.arrayBuffer();
    const sliced =
      buffer.byteLength > RESPONSE_SUMMARY_MAX_BYTES
        ? buffer.slice(0, RESPONSE_SUMMARY_MAX_BYTES)
        : buffer;
    const text = new TextDecoder("utf-8", { fatal: false }).decode(sliced);
    return truncateChars(text);
  } catch {
    return `<unreadable response body (status ${response.status})>`;
  }
}

function truncateChars(s: string): string {
  // Collapse newlines so log lines stay structured.
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= RESPONSE_SUMMARY_MAX_CHARS) return flat;
  return `${flat.slice(0, RESPONSE_SUMMARY_MAX_CHARS)}…`;
}

/**
 * Classify a fetch / network error into the runtime's `error_class` enum.
 *
 *   - AbortError (timeout)          -> `timeout`
 *   - everything else                -> `transient`
 *
 * The runtime maps both to `failed_retryable`; the `error_class` is what
 * the DLQ headers + dashboards pivot on.
 */
function classifyNetworkError(err: unknown): "timeout" | "transient" {
  if (err instanceof Error && err.name === "AbortError") return "timeout";
  return "transient";
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return truncateChars(`${err.name}: ${err.message}`);
  }
  if (typeof err === "string") return truncateChars(err);
  return "unknown error";
}
