/**
 * GA4 Measurement Protocol v1 deliverer.
 *
 * Per `docs/architecture/06-destinations.md`, the deliverer is the only
 * stage that talks to the network. The shape of the call here is:
 *
 *   1. Parse the resolved secret as the JSON envelope
 *      `{ measurement_id, api_secret }`. Any other shape is
 *      `failed_permanent` (`error_class: 'auth'`).
 *
 *   2. Build the Measurement Protocol URL:
 *
 *        https://<host>/mp/collect?measurement_id=<id>&api_secret=<secret>
 *
 *      The host comes from the service config (default
 *      `www.google-analytics.com`). Unlike TikTok / Meta CAPI, GA4's
 *      Measurement Protocol places the credential in the QUERY STRING,
 *      not a header. The deliverer redacts `api_secret=...` from every
 *      `vendor_response_summary` before it lands in PostgreSQL.
 *
 *   3. Lift the mapper's `wrapper` block onto the request body and
 *      JSON-serialize what remains as the single `events[]` entry.
 *
 *   4. POST with a per-attempt timeout.
 *
 *   5. Map the HTTP response to the runtime's outcome enum. GA4
 *      Measurement Protocol returns HTTP 204 No Content on success and
 *      HTTP 2xx on the `/debug/mp/collect` debug variant:
 *        - 2xx (incl. 204)       → accepted
 *        - 408                   → failed_retryable + error_class='timeout'
 *        - 429                   → failed_retryable + error_class='rate_limit'
 *        - 5xx                   → failed_retryable + error_class='transient'
 *        - 401 / 403             → failed_permanent + error_class='auth'
 *        - other 4xx             → failed_permanent + error_class='permanent'
 *        - network/abort error   → failed_retryable + classification
 *
 *   6. Truncate the response body to a label-safe summary for
 *      `vendor_response_summary`. The api_secret is redacted from the
 *      summary defensively (the URL is the only place GA4 sees the
 *      secret, but Google's error pages have historically echoed
 *      request URLs).
 *
 * The deliverer does NOT throw on HTTP / network failures; it catches
 * and returns a typed `DelivererResult`. A `throw` from this function
 * is treated by the runtime as a transient programmer bug.
 *
 * The request wrapper is NOT derived here. Everything on it —
 * `client_id`, `user_id`, `consent`, `user_properties`, `ip_override`,
 * `user_agent`, `user_location` — is resolved from the canonical envelope,
 * and the deliverer never sees one; the mapper resolves them onto
 * `Ga4EventPayload.wrapper` and this stage lifts that block out and strips
 * it from the `events[]` entry.
 *
 * `timestamp_micros` is the one exception, and the reason is the clock.
 * GA4 accepts a backdated timestamp only within 72 hours of RECEIPT, so
 * whether to send it is a question about now, and the mapper is pure. The
 * mapper hands over `occurred_at_epoch_ms`; `resolveTimestampMicros`
 * decides here.
 */

import type { Deliverer, DelivererContext, DelivererResult } from "@polaris/delivery-destinations";

import { parseGa4ProjectConfig } from "./project-config.js";
import type { Ga4EventPayload, Ga4RequestBody, Ga4WireEvent, ResolvedGa4Secret } from "./types.js";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Options accepted by `buildGa4Deliverer`. */
export interface BuildDelivererOptions {
  /** `fetch`-compatible implementation. Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Per-attempt request timeout in milliseconds. */
  readonly requestTimeoutMs: number;
  /** Override the Measurement Protocol host (test envs). Defaults to www.google-analytics.com. */
  readonly apiHost?: string;
}

/** Build a `Deliverer<Ga4EventPayload>` bound to a fetch + timeout + host. */
export function buildGa4Deliverer(options: BuildDelivererOptions): Deliverer<Ga4EventPayload> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  // Deployment defaults. Each is overridable per project; a project that sets
  // nothing gets exactly these, which is what POLARIS_GA4_* meant.
  const defaultTimeoutMs = options.requestTimeoutMs;
  const defaultHost = options.apiHost ?? "www.google-analytics.com";

  return async function deliver(
    context: DelivererContext<Ga4EventPayload>,
  ): Promise<DelivererResult> {
    // 0. Per-project overrides. Parsed per delivery rather than per batch
    //    because the runtime hands the slice in on the context; the parse is a
    //    Zod safeParse over at most two keys, and correctness here is worth
    //    more than the microseconds — a batch-level cache would have to be
    //    invalidated on the same signal the store already handles.
    const projectConfig = parseGa4ProjectConfig(context.projectConfig);
    const timeoutMs = projectConfig.request_timeout_ms ?? defaultTimeoutMs;
    const host = projectConfig.api_host ?? defaultHost;

    // 1. Parse secret.
    const secret = parseResolvedSecret(context.secret);
    if (secret === null) {
      return {
        kind: "failed_permanent",
        error_class: "auth",
        vendor_response_summary:
          "secret value did not resolve to {measurement_id, api_secret} JSON",
      };
    }

    // 2. URL. App-stream routing kicks in when the mapper produced an
    //    `app_instance_id` hint AND the operator has rotated their
    //    secret to include `firebase_app_id`; otherwise we stay on the
    //    web-stream URL with the synthesized `client_id`.
    const timestamp = resolveTimestampMicros(context.payload.wrapper.occurred_at_epoch_ms);
    const requestBody = buildRequestBody(context, secret, timestamp);
    const useAppStream = requestBody.app_instance_id !== undefined;
    const url = useAppStream
      ? buildFirebaseAppStreamUrl(host, secret.firebase_app_id as string, secret.api_secret)
      : buildMeasurementProtocolUrl(host, secret.measurement_id, secret.api_secret);

    // 3. Body.
    const body = JSON.stringify(requestBody);

    // 4. POST with timeout.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      return {
        kind: "failed_retryable",
        error_class: classifyNetworkError(err),
        vendor_response_summary: note(
          timestamp.diagnostic,
          redactToken(summarizeError(err), secret.api_secret),
        ),
      };
    } finally {
      clearTimeout(timer);
    }

    // 5. Read response + map status. GA4 returns 204 No Content on
    // success, so we expect an empty body on the happy path; the
    // generic readSummary handles empty bodies gracefully.
    const summary = note(
      timestamp.diagnostic,
      redactToken(await readSummary(response), secret.api_secret),
    );
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
// Request body builder
// ---------------------------------------------------------------------------

/**
 * Build the GA4 Measurement Protocol request body. Public so tests can
 * assert the wrapper shape independent of the network call.
 *
 * Every request-level field except `timestamp_micros` comes off the
 * mapper's `wrapper` block, unchanged. Nothing is derived here and there
 * is no fallback for a missing field: `wrapper` is required on the
 * payload, so a value that did not arrive is a mapper bug and shows up as
 * a type error rather than as a quietly different wire shape.
 *
 * The `events[]` entry is the payload MINUS `wrapper` — the block is a
 * side channel, and GA4 rejects an event entry carrying a key it does not
 * recognise.
 */
export function buildRequestBody(
  context: DelivererContext<Ga4EventPayload>,
  secret?: ResolvedGa4Secret,
  timestamp: TimestampResolution = resolveTimestampMicros(
    context.payload.wrapper.occurred_at_epoch_ms,
  ),
): Ga4RequestBody {
  const { wrapper, ...wireEvent } = context.payload;
  const events: readonly Ga4WireEvent[] = [wireEvent];

  // Fields that ride every request regardless of which stream it goes to.
  const common = {
    ...(wrapper.user_id !== undefined ? { user_id: wrapper.user_id } : {}),
    ...(timestamp.micros !== null ? { timestamp_micros: timestamp.micros } : {}),
    consent: wrapper.consent,
    ...(wrapper.user_properties !== undefined ? { user_properties: wrapper.user_properties } : {}),
    ...(wrapper.ip_override !== undefined ? { ip_override: wrapper.ip_override } : {}),
    ...(wrapper.user_agent !== undefined ? { user_agent: wrapper.user_agent } : {}),
    ...(wrapper.user_location !== undefined ? { user_location: wrapper.user_location } : {}),
    events,
  };

  // App-stream routing only fires when BOTH the mapper supplied a hint
  // AND the operator's secret carries `firebase_app_id`. Operators on a
  // web-only data stream (no `firebase_app_id` in their secret yet) get
  // the legacy `client_id` wrapper even if the envelope is app-source —
  // GA4 Web rejects `app_instance_id` requests so we cannot ship a half
  // routing.
  if (wrapper.app_instance_id !== undefined && secret?.firebase_app_id !== undefined) {
    return Object.freeze({
      app_instance_id: wrapper.app_instance_id,
      ...common,
    }) as Ga4RequestBody;
  }
  // `context.delivery_key` used to stand in for `client_id` here. It is
  // derived per (destination, event_id, identity), so it changed on every
  // event and GA4 saw one single-event user per delivery — no sessions, no
  // returning users, no funnel spanning two events. The mapper now resolves
  // a stable id from the canonical identity; see `resolveClientId`.
  return Object.freeze({ client_id: wrapper.client_id, ...common }) as Ga4RequestBody;
}

// ---------------------------------------------------------------------------
// Timestamp window
// ---------------------------------------------------------------------------

/**
 * GA4's backdating limit. A `timestamp_micros` older than this is not
 * rejected — `/debug/mp/collect` returns an empty `validationMessages`
 * for one 30 days old — the endpoint accepts the request and discards
 * the event. Silent loss, which is why the window is enforced here and
 * why falling outside it is worth a diagnostic on the delivery record.
 */
export const GA4_TIMESTAMP_MAX_AGE_MS = 72 * 60 * 60 * 1000;

/**
 * Outcome of the window check: the value to send, or `null` and the
 * reason it was withheld.
 */
export interface TimestampResolution {
  readonly micros: number | null;
  readonly diagnostic: string | null;
}

/**
 * Decide whether `occurred_at` can ride the request as
 * `timestamp_micros`.
 *
 * Sent on EVERY request inside the window. It used to be conditional on
 * the mapper having populated `engagement_time_msec`, which no mapper did
 * — so the field was documented, typed, and never once sent, and every
 * event landed in GA4 stamped with its delivery time instead of its own.
 * A backlog drained after an outage reported itself as a spike at the
 * moment of recovery.
 *
 * A future timestamp is left alone: clock skew of a few seconds is normal
 * on producer-supplied `occurred_at`, GA4 accepts it, and second-guessing
 * it here would need a tolerance nobody can pick well.
 */
export function resolveTimestampMicros(
  occurredAtEpochMs: number,
  nowMs: number = Date.now(),
): TimestampResolution {
  if (!Number.isFinite(occurredAtEpochMs)) {
    return { micros: null, diagnostic: "timestamp_micros omitted: occurred_at is not a number" };
  }
  const ageMs = nowMs - occurredAtEpochMs;
  if (ageMs > GA4_TIMESTAMP_MAX_AGE_MS) {
    const ageHours = Math.floor(ageMs / (60 * 60 * 1000));
    return {
      micros: null,
      diagnostic: `timestamp_micros omitted: occurred_at is ${ageHours}h old, past GA4's 72h backdating window`,
    };
  }
  return { micros: occurredAtEpochMs * 1000, diagnostic: null };
}

/**
 * Prefix a Polaris-side note onto the vendor's own response summary.
 *
 * `vendor_response_summary` is the triage field an operator reads off
 * `delivery_records`, and it is the only channel a deliverer has: the
 * stage takes no logger, by design. "GA4 stamped this event with its
 * receive time and here is why" belongs where somebody asking that
 * question is already looking.
 */
function note(diagnostic: string | null, summary: string): string {
  if (diagnostic === null) return summary;
  return summary.length === 0 ? `[polaris] ${diagnostic}` : `[polaris] ${diagnostic}; ${summary}`;
}

// ---------------------------------------------------------------------------
// Secret parsing
// ---------------------------------------------------------------------------

/**
 * Parse the resolved secret into a `ResolvedGa4Secret`. Returns `null`
 * if the shape is not recognised. Public so tests + the descriptor
 * wiring can share the validation logic.
 *
 * Expected shape:
 *
 *   { "measurement_id": "G-XXXXXXXXXX", "api_secret": "..." }
 *
 * Both `measurement_id` and `api_secret` must be non-empty strings.
 */
export function parseResolvedSecret(secret: string): ResolvedGa4Secret | null {
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
  const measurementId = obj["measurement_id"];
  const apiSecret = obj["api_secret"];
  if (typeof measurementId !== "string" || measurementId.length === 0) return null;
  if (typeof apiSecret !== "string" || apiSecret.length === 0) return null;
  const firebaseAppId = obj["firebase_app_id"];
  if (typeof firebaseAppId === "string" && firebaseAppId.length > 0) {
    return {
      measurement_id: measurementId,
      api_secret: apiSecret,
      firebase_app_id: firebaseAppId,
    };
  }
  return { measurement_id: measurementId, api_secret: apiSecret };
}

// ---------------------------------------------------------------------------
// URL builder
// ---------------------------------------------------------------------------

/**
 * Build the GA4 Measurement Protocol URL. Public so tests can assert
 * the shape.
 *
 * GA4's contract is
 * `https://<host>/mp/collect?measurement_id=<id>&api_secret=<secret>`.
 * Both credentials ride in the query string per Google's documented
 * Measurement Protocol contract; there is no `Authorization` header
 * option. The api_secret is redacted from `vendor_response_summary`
 * before it lands in PostgreSQL.
 */
export function buildMeasurementProtocolUrl(
  host: string,
  measurementId: string,
  apiSecret: string,
): string {
  const params = new URLSearchParams();
  params.set("measurement_id", measurementId);
  params.set("api_secret", apiSecret);
  return `https://${host}/mp/collect?${params.toString()}`;
}

/**
 * Build the GA4 Firebase / app-stream URL flavor (KCS3ATPC).
 *
 * GA4 routes mobile-app events through a different query-string
 * credential — `firebase_app_id=<id>` instead of `measurement_id=<id>`.
 * Same host, same path, same `api_secret` redaction posture as the
 * web-stream URL; the contract is otherwise identical.
 */
export function buildFirebaseAppStreamUrl(
  host: string,
  firebaseAppId: string,
  apiSecret: string,
): string {
  const params = new URLSearchParams();
  params.set("firebase_app_id", firebaseAppId);
  params.set("api_secret", apiSecret);
  return `https://${host}/mp/collect?${params.toString()}`;
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
    // GA4 returns 204 No Content on success — the body is empty by
    // contract. We surface a stable label so vendor_response_summary
    // doesn't look like a parsing accident in PostgreSQL.
    if (buffer.byteLength === 0) {
      return response.status === 204 ? "204 No Content" : "";
    }
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
 * Belt-and-braces: ensure the resolved api_secret doesn't end up in a
 * vendor response summary that ultimately lands in `delivery_records.
 * vendor_response_summary`. The deliverer DOES put the secret in the
 * URL (GA4's Measurement Protocol contract), and Google's error pages
 * have historically echoed request URLs; this defensive sweep is
 * tied to the actually-resolved api_secret.
 */
function redactToken(text: string, secret: string): string {
  if (secret.length < 8) return text;
  if (!text.includes(secret)) return text;
  return text.split(secret).join("[redacted-api-secret]");
}
