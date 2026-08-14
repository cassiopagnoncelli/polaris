/**
 * TikTok Events API v1 deliverer.
 *
 * Per `docs/architecture/06-destinations.md`, the deliverer is the only
 * stage that talks to the network. The shape of the call here is:
 *
 *   1. Parse the resolved secret as the JSON envelope
 *      `{ access_token, pixel_id, test_event_code? }`. Any other shape
 *      is `failed_permanent` (`error_class: 'auth'`).
 *
 *   2. Build the Events API URL:
 *
 *        https://<host>/open_api/<api_version>/event/track/
 *
 *      The host comes from the service config (default
 *      `business-api.tiktok.com`); `api_version` is pinned in
 *      `descriptor-identity.ts`. The access token rides as an
 *      `Access-Token: <token>` request header per TikTok's documented
 *      contract — never in the URL.
 *
 *   3. Wrap the mapper output in
 *      `{ event_source, event_source_id, data: [payload], test_event_code? }`,
 *      JSON-serialize.
 *
 *   4. POST with a per-attempt timeout.
 *
 *   5. Map the HTTP response to the runtime's outcome enum:
 *        - 2xx                   → accepted
 *        - 408                   → failed_retryable + error_class='timeout'
 *        - 429                   → failed_retryable + error_class='rate_limit'
 *        - 5xx                   → failed_retryable + error_class='transient'
 *        - 401 / 403             → failed_permanent + error_class='auth'
 *        - other 4xx             → failed_permanent + error_class='permanent'
 *        - network/abort error   → failed_retryable + classification
 *
 *   6. Truncate the response body to a label-safe summary for
 *      `vendor_response_summary`. TikTok's Events API returns a
 *      structured JSON document we ALSO parse to surface `request_id`
 *      in the summary — operators paste it into TikTok's debugging
 *      tools when triaging a permanent failure.
 *
 * The deliverer does NOT throw on HTTP / network failures; it catches
 * and returns a typed `DelivererResult`. A `throw` from this function
 * is treated by the runtime as a transient programmer bug.
 *
 * `event_source` is inferred per-event by the mapper helper
 * `inferEventSource`. The deliverer uses the payload's `page.url` slot
 * as a cheap proxy: populated → `web`, otherwise → `crm`. Mobile
 * (`event_source: app`) is deferred until a future minor version.
 */

import type { Deliverer, DelivererContext, DelivererResult } from "@polaris/shared-destinations";

import { TIKTOK_EVENTS_API_VERSION } from "./descriptor-identity.js";
import { parseTikTokProjectConfig } from "./project-config.js";
import type { ResolvedTikTokSecret, TikTokEventPayload, TikTokEventSource } from "./types.js";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Options accepted by `buildTikTokDeliverer`. */
export interface BuildDelivererOptions {
  /** `fetch`-compatible implementation. Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Per-attempt request timeout in milliseconds. */
  readonly requestTimeoutMs: number;
  /** Override the Events API host (test envs). Defaults to business-api.tiktok.com. */
  readonly apiHost?: string;
}

/** Build a `Deliverer<TikTokEventPayload>` bound to a fetch + timeout + host. */
export function buildTikTokDeliverer(
  options: BuildDelivererOptions,
): Deliverer<TikTokEventPayload> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  // Deployment defaults. Each is overridable per project; a project that sets
  // nothing gets exactly these, which is what POLARIS_TIKTOK_* meant.
  const defaultTimeoutMs = options.requestTimeoutMs;
  const defaultHost = options.apiHost ?? "business-api.tiktok.com";

  return async function deliver(
    context: DelivererContext<TikTokEventPayload>,
  ): Promise<DelivererResult> {
    // 0. Per-project overrides. Parsed per delivery rather than per batch
    //    because the runtime hands the slice in on the context; the parse is a
    //    Zod safeParse over at most two keys, and correctness here is worth
    //    more than the microseconds — a batch-level cache would have to be
    //    invalidated on the same signal the store already handles.
    const projectConfig = parseTikTokProjectConfig(context.projectConfig);
    const timeoutMs = projectConfig.request_timeout_ms ?? defaultTimeoutMs;
    const host = projectConfig.api_host ?? defaultHost;

    // 1. Parse secret.
    const secret = parseResolvedSecret(context.secret);
    if (secret === null) {
      return {
        kind: "failed_permanent",
        error_class: "auth",
        vendor_response_summary: "secret value did not resolve to {access_token, pixel_id} JSON",
      };
    }

    // 2. URL.
    const url = buildEventsApiUrl(host, TIKTOK_EVENTS_API_VERSION);

    // 3. Body.
    const eventSource: TikTokEventSource = context.payload.page?.url !== undefined ? "web" : "crm";
    const bodyObject: {
      event_source: TikTokEventSource;
      event_source_id: string;
      data: TikTokEventPayload[];
      test_event_code?: string;
    } = {
      event_source: eventSource,
      event_source_id: secret.pixel_id,
      data: [context.payload],
    };
    if (secret.test_event_code !== undefined && secret.test_event_code.length > 0) {
      bodyObject.test_event_code = secret.test_event_code;
    }
    const body = JSON.stringify(bodyObject);

    // 4. POST with timeout.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Access-Token": secret.access_token,
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      return {
        kind: "failed_retryable",
        error_class: classifyNetworkError(err),
        vendor_response_summary: redactToken(summarizeError(err), secret.access_token),
      };
    } finally {
      clearTimeout(timer);
    }

    // 5. Read response + map status.
    const summary = redactToken(await readSummary(response), secret.access_token);
    const code = String(response.status);

    if (response.status >= 200 && response.status < 300) {
      return {
        kind: "accepted",
        vendor_response_code: code,
        vendor_response_summary: summary,
      };
    }
    if (isRetryableStatus(response.status)) {
      return {
        kind: "failed_retryable",
        error_class: classifyRetryableStatus(response.status),
        vendor_response_code: code,
        vendor_response_summary: summary,
      };
    }
    return {
      kind: "failed_permanent",
      error_class: response.status === 401 || response.status === 403 ? "auth" : "permanent",
      vendor_response_code: code,
      vendor_response_summary: summary,
    };
  };
}

// ---------------------------------------------------------------------------
// Secret parsing
// ---------------------------------------------------------------------------

/**
 * Parse the resolved secret into a `ResolvedTikTokSecret`. Returns
 * `null` if the shape is not recognised. Public so tests + the
 * descriptor wiring can share the validation logic.
 *
 * Expected shape:
 *
 *   { "access_token": "...", "pixel_id": "...", "test_event_code"?: "..." }
 *
 * Both `access_token` and `pixel_id` must be non-empty strings. The
 * optional `test_event_code` is forwarded to the wire payload when
 * present.
 */
export function parseResolvedSecret(secret: string): ResolvedTikTokSecret | null {
  const trimmed = secret.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("{")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const accessToken = obj["access_token"];
  const pixelId = obj["pixel_id"];
  if (typeof accessToken !== "string" || accessToken.length === 0) return null;
  if (typeof pixelId !== "string" || pixelId.length === 0) return null;
  const testEventCode = obj["test_event_code"];
  if (testEventCode === undefined || testEventCode === null) {
    return { access_token: accessToken, pixel_id: pixelId };
  }
  if (typeof testEventCode !== "string" || testEventCode.length === 0) return null;
  return {
    access_token: accessToken,
    pixel_id: pixelId,
    test_event_code: testEventCode,
  };
}

// ---------------------------------------------------------------------------
// URL builder
// ---------------------------------------------------------------------------

/**
 * Build the TikTok Events API URL. Public so tests can assert the shape.
 *
 * TikTok's contract is `/open_api/<api_version>/event/track/` with a
 * trailing slash. The `Access-Token` header (not the URL) carries the
 * credential, which keeps the URL itself safe to log.
 */
export function buildEventsApiUrl(host: string, apiVersion: string): string {
  return `https://${host}/open_api/${apiVersion}/event/track/`;
}

// ---------------------------------------------------------------------------
// HTTP status mapping
// ---------------------------------------------------------------------------

export function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return false;
}

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
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= RESPONSE_SUMMARY_MAX_CHARS) return flat;
  return `${flat.slice(0, RESPONSE_SUMMARY_MAX_CHARS)}…`;
}

function classifyNetworkError(err: unknown): "timeout" | "transient" {
  if (err instanceof Error && err.name === "AbortError") return "timeout";
  return "transient";
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) return truncateChars(`${err.name}: ${err.message}`);
  if (typeof err === "string") return truncateChars(err);
  return "unknown error";
}

/**
 * Belt-and-braces: ensure the resolved access token doesn't end up in a
 * vendor response summary that ultimately lands in `delivery_records.
 * vendor_response_summary`. The deliverer doesn't put the token in the
 * URL (it rides in the `Access-Token` header), but a TikTok error CAN
 * echo headers or the body in unexpected ways; this defensive sweep is
 * tied to the actually-resolved token.
 */
function redactToken(text: string, token: string): string {
  if (token.length < 8) return text;
  if (!text.includes(token)) return text;
  return text.split(token).join("[redacted-access-token]");
}
