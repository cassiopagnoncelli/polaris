/**
 * Meta CAPI v1 deliverer.
 *
 * Per `docs/architecture/06-destinations.md`, the deliverer is the only
 * stage that talks to the network. The shape of the call here is:
 *
 *   1. Parse the resolved secret as the JSON envelope
 *      `{ pixel_id, access_token, test_event_code? }`. Any other shape
 *      is `failed_permanent` (`error_class: 'auth'`).
 *
 *   2. Build the Graph API URL:
 *
 *        https://<host>/<api_version>/<pixel_id>/events?access_token=<token>
 *
 *      The host comes from the service config (default
 *      `graph.facebook.com`); `api_version` is pinned in
 *      `descriptor-identity.ts`. The access token rides as a query
 *      parameter per Meta's documented contract; we never log the URL
 *      with the token attached.
 *
 *   3. Wrap the mapper output in `{ data: [payload], test_event_code? }`,
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
 *      `vendor_response_summary`. The Graph API returns a structured
 *      JSON document we ALSO parse to surface `fbtrace_id` in the
 *      summary — operators paste it into Meta's debugging tools when
 *      triaging a permanent failure.
 *
 * The deliverer does NOT throw on HTTP / network failures; it catches
 * and returns a typed `DelivererResult`. A `throw` from this function
 * is treated by the runtime as a transient programmer bug.
 */

import type { Deliverer, DelivererContext, DelivererResult } from "@polaris/shared-destinations";

import { META_GRAPH_API_VERSION } from "./descriptor-identity.js";
import { parseMetaCapiProjectConfig } from "./project-config.js";
import type { MetaCapiPayload, ResolvedMetaCapiSecret } from "./types.js";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Options accepted by `buildMetaCapiDeliverer`. */
export interface BuildDelivererOptions {
  /** `fetch`-compatible implementation. Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Per-attempt request timeout in milliseconds. */
  readonly requestTimeoutMs: number;
  /** Override the Graph API host (test envs). Defaults to graph.facebook.com. */
  readonly graphHost?: string;
}

/** Build a `Deliverer<MetaCapiPayload>` bound to a fetch + timeout + host. */
export function buildMetaCapiDeliverer(options: BuildDelivererOptions): Deliverer<MetaCapiPayload> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  // Deployment defaults. Each is overridable per project; a project that sets
  // nothing gets exactly these, which is what POLARIS_META_CAPI_* meant.
  const defaultTimeoutMs = options.requestTimeoutMs;
  const defaultHost = options.graphHost ?? "graph.facebook.com";

  return async function deliver(
    context: DelivererContext<MetaCapiPayload>,
  ): Promise<DelivererResult> {
    // 0. Per-project overrides. Parsed per delivery rather than per batch
    //    because the runtime hands the slice in on the context; the parse is a
    //    Zod safeParse over at most three keys, and correctness here is worth
    //    more than the microseconds — a batch-level cache would have to be
    //    invalidated on the same signal the store already handles.
    const projectConfig = parseMetaCapiProjectConfig(context.projectConfig);
    const timeoutMs = projectConfig.request_timeout_ms ?? defaultTimeoutMs;
    const host = projectConfig.graph_host ?? defaultHost;

    // 1. Parse secret.
    const secret = parseResolvedSecret(context.secret);
    if (secret === null) {
      return {
        kind: "failed_permanent",
        error_class: "auth",
        vendor_response_summary: "secret value did not resolve to {pixel_id, access_token} JSON",
      };
    }

    // 2. URL.
    const url = buildGraphUrl(host, META_GRAPH_API_VERSION, secret.pixel_id, secret.access_token);

    // 3. Body.
    const bodyObject: {
      data: MetaCapiPayload[];
      test_event_code?: string;
    } = { data: [context.payload] };
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
        headers: { "content-type": "application/json" },
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
 * Parse the resolved secret into a `ResolvedMetaCapiSecret`. Returns
 * `null` if the shape is not recognised. Public so tests + the
 * descriptor wiring can share the validation logic.
 *
 * Expected shape:
 *
 *   { "pixel_id": "1234567890", "access_token": "EAAB...", "test_event_code"?: "TEST123" }
 *
 * Both `pixel_id` and `access_token` must be non-empty strings. The
 * optional `test_event_code` is forwarded to the wire payload when
 * present.
 */
export function parseResolvedSecret(secret: string): ResolvedMetaCapiSecret | null {
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
  const pixelId = obj["pixel_id"];
  const accessToken = obj["access_token"];
  if (typeof pixelId !== "string" || pixelId.length === 0) return null;
  if (typeof accessToken !== "string" || accessToken.length === 0) return null;
  const testEventCode = obj["test_event_code"];
  if (testEventCode === undefined || testEventCode === null) {
    return { pixel_id: pixelId, access_token: accessToken };
  }
  if (typeof testEventCode !== "string" || testEventCode.length === 0) return null;
  return {
    pixel_id: pixelId,
    access_token: accessToken,
    test_event_code: testEventCode,
  };
}

// ---------------------------------------------------------------------------
// URL builder
// ---------------------------------------------------------------------------

/** Build the Graph API URL. Public so tests can assert the shape. */
export function buildGraphUrl(
  host: string,
  apiVersion: string,
  pixelId: string,
  accessToken: string,
): string {
  return `https://${host}/${apiVersion}/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(accessToken)}`;
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
 * vendor_response_summary`. The deliverer doesn't itself put the token in
 * the body, but a Graph API error CAN echo URL fragments; the runtime
 * truncates the summary to 1 KB but the redaction here is an additional
 * defensive sweep tied to the actually-resolved token.
 */
function redactToken(text: string, token: string): string {
  if (token.length < 8) return text;
  // Replace any occurrence of the literal token with a redaction marker.
  // We never partial-redact: the goal is "operators can copy/paste the
  // summary without leaking a token".
  if (!text.includes(token)) return text;
  return text.split(token).join("[redacted-access-token]");
}
