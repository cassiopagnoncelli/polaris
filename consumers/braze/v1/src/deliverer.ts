/**
 * Braze REST API v1 deliverer.
 *
 * Per `docs/architecture/06-destinations.md`, the deliverer is the only
 * stage that talks to the network. The shape of the call here is:
 *
 *   1. Parse the resolved secret as the JSON envelope
 *      `{ instance, api_key }`. Any other shape is `failed_permanent`
 *      (`error_class: 'auth'`).
 *
 *   2. Build the Braze REST URL:
 *
 *        https://rest.<instance>.braze.com/users/track
 *
 *      `instance` is the Braze workspace's instance slug (`iad-01`,
 *      `iad-02`, ..., `eu-01`, `eu-02`, ...). Routing to the wrong
 *      instance returns 401/403; the deliverer classifies that as
 *      `failed_permanent` + `auth`. The host is overridable via the
 *      `apiHost` option (`{instance}` substitution) for test environments.
 *
 *   3. Mapper output is a `BrazePayload` populated with exactly one of
 *      `attributes[]`, `events[]`, `purchases[]`. The deliverer
 *      JSON-serializes the value directly into the wire body — Braze's
 *      `/users/track` accepts that exact shape.
 *
 *   4. POST with a per-attempt timeout. Auth rides as
 *      `Authorization: Bearer <api_key>` per Braze's documented contract.
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
 *      `vendor_response_summary`. Braze's REST surfaces `errors[]` and
 *      a top-level `message`; both survive the truncation for operator
 *      triage.
 *
 * The deliverer does NOT throw on HTTP / network failures; it catches
 * and returns a typed `DelivererResult`. A `throw` from this function
 * is treated by the runtime as a transient programmer bug.
 *
 * The API key is redacted from `vendor_response_summary` defensively —
 * it never lives in the URL, but a Braze error CAN echo headers or the
 * body in unexpected ways and the redaction is keyed to the actually-
 * resolved key.
 */

import type { Deliverer, DelivererContext, DelivererResult } from "@polaris/shared-destinations";

import type { BrazePayload, ResolvedBrazeSecret } from "./types.js";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Options accepted by `buildBrazeDeliverer`. */
export interface BuildDelivererOptions {
  /** `fetch`-compatible implementation. Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Per-attempt request timeout in milliseconds. */
  readonly requestTimeoutMs: number;
  /**
   * Override the REST host template (test envs). The literal `{instance}`
   * is substituted with the resolved-secret `instance` slug. Defaults to
   * `rest.{instance}.braze.com` — Braze's production canonical host
   * template.
   */
  readonly apiHost?: string;
}

/** Build a `Deliverer<BrazePayload>` bound to a fetch + timeout + host template. */
export function buildBrazeDeliverer(options: BuildDelivererOptions): Deliverer<BrazePayload> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.requestTimeoutMs;
  const hostTemplate = options.apiHost ?? "rest.{instance}.braze.com";

  return async function deliver(context: DelivererContext<BrazePayload>): Promise<DelivererResult> {
    // 1. Parse secret.
    const secret = parseResolvedSecret(context.secret);
    if (secret === null) {
      return {
        kind: "failed_permanent",
        error_class: "auth",
        vendor_response_summary: "secret value did not resolve to {instance, api_key} JSON",
      };
    }

    // 2. URL.
    const url = buildUsersTrackUrl(hostTemplate, secret.instance);

    // 3. Body. Braze accepts the `BrazePayload` shape directly —
    // `{ attributes?, events?, purchases? }` with at least one populated.
    const body = JSON.stringify(context.payload);

    // 4. POST with timeout.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${secret.api_key}`,
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      return {
        kind: "failed_retryable",
        error_class: classifyNetworkError(err),
        vendor_response_summary: redactApiKey(summarizeError(err), secret.api_key),
      };
    } finally {
      clearTimeout(timer);
    }

    // 5. Read response + map status.
    const summary = redactApiKey(await readSummary(response), secret.api_key);
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
 * Parse the resolved secret into a `ResolvedBrazeSecret`. Returns
 * `null` if the shape is not recognised. Public so tests + the
 * descriptor wiring can share the validation logic.
 *
 * Expected shape:
 *
 *   { "instance": "iad-01", "api_key": "..." }
 *
 * Both `instance` and `api_key` must be non-empty strings. `instance`
 * is sanity-checked against Braze's documented slug pattern (lowercase
 * alnum + hyphens) so a typo in the secret manifest fails fast at
 * parse time instead of producing a confused URL.
 */
export function parseResolvedSecret(secret: string): ResolvedBrazeSecret | null {
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
  const instance = obj["instance"];
  const apiKey = obj["api_key"];
  if (typeof instance !== "string" || instance.length === 0) return null;
  if (typeof apiKey !== "string" || apiKey.length === 0) return null;
  if (!isValidInstanceSlug(instance)) return null;
  return { instance, api_key: apiKey };
}

/**
 * Braze instance slugs follow `[a-z]{2,3}-[0-9]{2}` in practice (`iad-01`,
 * `iad-02`, ..., `eu-01`, `eu-02`, ..., `us-01`, ...). v1 accepts the
 * broader `[a-z0-9-]+` pattern to stay forward-compatible with future
 * instance regions without forcing a code update; only obvious
 * structural noise (whitespace, dots, slashes, uppercase) is rejected.
 */
function isValidInstanceSlug(slug: string): boolean {
  return /^[a-z0-9-]+$/.test(slug);
}

// ---------------------------------------------------------------------------
// URL builder
// ---------------------------------------------------------------------------

/**
 * Build the Braze REST API URL. Public so tests can assert the shape.
 *
 * `hostTemplate` carries a `{instance}` literal that is replaced with
 * the resolved-secret `instance` slug. The path is `/users/track` —
 * Braze's documented endpoint for batch attribute/event/purchase
 * recording.
 *
 * The bearer token (not the URL) carries the credential, which keeps
 * the URL itself safe to log.
 */
export function buildUsersTrackUrl(hostTemplate: string, instance: string): string {
  const host = hostTemplate.includes("{instance}")
    ? hostTemplate.replace("{instance}", instance)
    : hostTemplate;
  return `https://${host}/users/track`;
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
 * Belt-and-braces: ensure the resolved API key doesn't end up in a
 * vendor response summary that ultimately lands in `delivery_records.
 * vendor_response_summary`. The deliverer doesn't put the key in the
 * URL (it rides in `Authorization: Bearer`), but a Braze error CAN
 * echo headers or the body in unexpected ways; this defensive sweep is
 * tied to the actually-resolved key.
 */
function redactApiKey(text: string, apiKey: string): string {
  if (apiKey.length < 8) return text;
  if (!text.includes(apiKey)) return text;
  return text.split(apiKey).join("[redacted-api-key]");
}
