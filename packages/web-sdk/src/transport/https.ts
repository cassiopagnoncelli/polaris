/**
 * HTTPS POST transport for the Web SDK.
 *
 * Per `docs/architecture/10-sdk-standards.md` § Web SDK Flush Lifecycle:
 *
 *   "Use `navigator.sendBeacon` or `fetch(..., { keepalive: true })`
 *    where appropriate for page-exit flushes. Unload/page-exit delivery
 *    is best-effort and must not be treated as guaranteed."
 *
 * Modes:
 *
 *   - `steady`  — uses `fetch` with default semantics. The caller awaits
 *                 the response and parses per-event accept/reject.
 *   - `urgent`  — page-exit best-effort. Tries `navigator.sendBeacon`
 *                 first (queued by the browser before the tab dies),
 *                 falls back to `fetch(..., { keepalive: true })` when
 *                 sendBeacon is unavailable or rejects the payload (e.g.
 *                 above the per-browser 64KB beacon limit).
 *
 * Permanent vs transient rejections:
 *
 *   - `2xx` -> per-event batch result parsed from response body.
 *   - `4xx` (except 408/429) -> permanent transport-layer failure
 *     (throws `TransportError` with `retryable=false`).
 *   - `5xx`, `408`, `429`, network errors, timeouts -> retryable.
 *
 * The ingester returns partial-acceptance batch results per
 * `04-ingestion-and-sdks.md`. Permanent per-event rejections (closed-set
 * reason codes like `schema_validation_failed`) are surfaced via the
 * batch response body, NOT via HTTP status — the transport layer parses
 * them and tags each rejection's `retryable` flag.
 */

import type {
  QueuedEventPayload,
  Transport,
  TransportEventResult,
  TransportMode,
  TransportResult,
} from "../types.js";

export class TransportError extends Error {
  public override readonly name = "TransportError";
  public readonly retryable: boolean;
  public readonly status?: number;
  public readonly code?: string;

  public constructor(
    message: string,
    options: { readonly retryable: boolean; readonly status?: number; readonly code?: string },
  ) {
    super(message);
    this.retryable = options.retryable;
    if (options.status !== undefined) this.status = options.status;
    if (options.code !== undefined) this.code = options.code;
  }
}

export interface HttpsTransportOptions {
  readonly endpoint: string;
  readonly apiKey: string;
  /** Optional User-Agent. Some browsers ignore this for security; the SDK still sends it where allowed. */
  readonly userAgent?: string;
  /** Optional request timeout in ms. Defaults to 10 seconds. */
  readonly requestTimeoutMs?: number;
  /**
   * Inject a custom `fetch` implementation (tests pass a vi.fn). Defaults
   * to the global `fetch`. Throws at construction if neither is available.
   */
  readonly fetch?: typeof fetch;
  /**
   * Inject a custom `sendBeacon` implementation (tests). Defaults to
   * `navigator.sendBeacon` when present. When undefined and unavailable,
   * urgent flushes fall back to `fetch(..., { keepalive: true })`.
   */
  readonly sendBeacon?: (url: string, body: string) => boolean;
}

interface BatchResponseEntry {
  readonly event_id: string;
  readonly status: "accepted" | "rejected";
  readonly reason?: string;
}

interface BatchResponse {
  readonly accepted?: readonly BatchResponseEntry[];
  readonly rejected?: readonly BatchResponseEntry[];
}

/**
 * Closed-set permanent rejection reasons returned by the ingester
 * (per `04-ingestion-and-sdks.md` and `10-sdk-standards.md`). The retry
 * coordinator must not retry these.
 */
const PERMANENT_REJECTION_REASONS = new Set([
  "schema_validation_failed",
  "unsupported_schema_version",
  "schema_version_sunset",
  "unknown_event",
  "invalid_properties",
  "invalid_envelope",
  "forbidden_field_rejected",
]);

const DEFAULT_TIMEOUT_MS = 10_000;

export class HttpsTransport implements Transport {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly userAgent: string | undefined;
  private readonly requestTimeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly sendBeaconFn: ((url: string, body: string) => boolean) | undefined;

  public constructor(options: HttpsTransportOptions) {
    if (typeof options.endpoint !== "string" || options.endpoint.length === 0) {
      throw new Error("HttpsTransport: endpoint is required");
    }
    if (typeof options.apiKey !== "string" || options.apiKey.length === 0) {
      throw new Error("HttpsTransport: apiKey is required");
    }
    this.endpoint = options.endpoint;
    this.apiKey = options.apiKey;
    this.userAgent = options.userAgent;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fetchFn = options.fetch ?? (typeof fetch !== "undefined" ? fetch : undefined);
    if (fetchFn === undefined) {
      throw new Error(
        "HttpsTransport: no fetch implementation available — pass `fetch` in options",
      );
    }
    this.fetchFn = fetchFn;
    this.sendBeaconFn = options.sendBeacon ?? resolveDefaultBeacon();
  }

  public async send(
    events: readonly QueuedEventPayload[],
    mode: TransportMode,
  ): Promise<TransportResult> {
    if (mode === "urgent") {
      return this.sendUrgent(events);
    }
    return this.sendSteady(events);
  }

  // ---- Steady mode: fetch with response parsing -----------------------

  private async sendSteady(events: readonly QueuedEventPayload[]): Promise<TransportResult> {
    const body = JSON.stringify({ events });
    const controller = createAbortController();
    const timer =
      controller === undefined
        ? undefined
        : setTimeout(() => controller.abort(), this.requestTimeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(this.endpoint, {
        method: "POST",
        body,
        headers: this.buildHeaders(),
        // `keepalive: true` is harmless for steady mode and lets the
        // browser deliver the request even if a navigation starts mid-flight.
        keepalive: true,
        ...(controller !== undefined ? { signal: controller.signal } : {}),
      });
    } catch (err) {
      if (timer !== undefined) clearTimeout(timer);
      throw classifyFetchError(err);
    }
    if (timer !== undefined) clearTimeout(timer);

    const status = response.status;
    if (status >= 200 && status < 300) {
      const text = await safeReadText(response);
      return parseBatchResponse(events, text);
    }
    if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
      throw new TransportError(`ingester returned ${status}`, {
        retryable: false,
        status,
      });
    }
    // 5xx, 408, 429 are retryable.
    throw new TransportError(`ingester returned ${status}`, {
      retryable: true,
      status,
    });
  }

  // ---- Urgent mode: sendBeacon / fetch keepalive ----------------------

  private async sendUrgent(events: readonly QueuedEventPayload[]): Promise<TransportResult> {
    const body = JSON.stringify({ events });
    // sendBeacon is fire-and-forget — the browser queues the request and
    // delivers it after the tab dies, but we never get the response. We
    // therefore treat all events as accepted on a successful queue. The
    // ingester's 15-minute dedupe window protects against duplicates if
    // the SDK retries after the navigation aborted.
    if (this.sendBeaconFn !== undefined) {
      try {
        const queued = this.sendBeaconFn(this.endpoint, body);
        if (queued) {
          return optimisticAcceptAll(events);
        }
      } catch {
        // Fall through to fetch keepalive.
      }
    }
    // Fall back to fetch keepalive. We do NOT await the response — at
    // pagehide the network is racing the unload, and awaiting can stall
    // the tab. Instead, we return optimistically and let the ingester
    // dedupe handle any second-time delivery.
    try {
      // Intentionally not awaited: the fetch call is fire-and-forget.
      const promise = this.fetchFn(this.endpoint, {
        method: "POST",
        body,
        headers: this.buildHeaders(),
        keepalive: true,
      });
      // Attach a no-op error handler so the promise rejection (if any)
      // does not surface as an unhandled-rejection warning in tests.
      promise.catch(() => undefined);
      return optimisticAcceptAll(events);
    } catch (err) {
      throw classifyFetchError(err);
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
    };
    if (this.userAgent !== undefined) {
      // Some browsers ignore User-Agent on fetch headers — that's fine,
      // the SDK doesn't depend on it being delivered.
      headers["X-Polaris-SDK"] = this.userAgent;
    }
    return headers;
  }
}

function resolveDefaultBeacon(): ((url: string, body: string) => boolean) | undefined {
  if (typeof navigator === "undefined") return undefined;
  const beacon = navigator.sendBeacon?.bind(navigator);
  if (beacon === undefined) return undefined;
  return (url, body) => {
    // sendBeacon expects a BodyInit. Strings are accepted but get a
    // text/plain content-type by default which the ingester routes via
    // its JSON parser; an explicit Blob lets us set application/json.
    const blob = new Blob([body], { type: "application/json" });
    return beacon(url, blob);
  };
}

function createAbortController(): AbortController | undefined {
  if (typeof AbortController === "undefined") return undefined;
  try {
    return new AbortController();
  } catch {
    return undefined;
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function classifyFetchError(err: unknown): TransportError {
  const error = err instanceof Error ? err : new Error(String(err));
  // AbortError surfaces as a DOMException at runtime; treat it as retryable
  // because it's almost always a timeout.
  const name = error.name;
  if (name === "AbortError" || name === "TimeoutError") {
    return new TransportError(`request timed out: ${error.message}`, {
      retryable: true,
      code: "ETIMEDOUT",
    });
  }
  return new TransportError(`transport error: ${error.message}`, {
    retryable: true,
    code: name,
  });
}

function optimisticAcceptAll(events: readonly QueuedEventPayload[]): TransportResult {
  const accepted: TransportEventResult[] = events.map((e) => ({
    event_id: e.event_id,
    status: "accepted" as const,
  }));
  return { accepted, rejected: [] };
}

function parseBatchResponse(events: readonly QueuedEventPayload[], body: string): TransportResult {
  const accepted: TransportEventResult[] = [];
  const rejected: TransportEventResult[] = [];

  let parsed: BatchResponse | undefined;
  if (body.length > 0) {
    try {
      const decoded = JSON.parse(body) as unknown;
      if (typeof decoded === "object" && decoded !== null) {
        parsed = decoded as BatchResponse;
      }
    } catch {
      // Defensive only; fall through to "all accepted given 2xx".
    }
  }

  if (parsed === undefined) {
    for (const event of events) {
      accepted.push({ event_id: event.event_id, status: "accepted" });
    }
    return { accepted, rejected };
  }

  const seen = new Set<string>();
  for (const entry of parsed.accepted ?? []) {
    seen.add(entry.event_id);
    accepted.push({ event_id: entry.event_id, status: "accepted" });
  }
  for (const entry of parsed.rejected ?? []) {
    seen.add(entry.event_id);
    const reason = entry.reason;
    const retryable = reason === undefined ? false : !PERMANENT_REJECTION_REASONS.has(reason);
    rejected.push({
      event_id: entry.event_id,
      status: "rejected",
      ...(reason !== undefined ? { reason } : {}),
      retryable,
    });
  }
  // Events the ingester did not echo back are treated as accepted to
  // avoid duplicating them on retry. The ingester contract is that every
  // event must appear in exactly one of `accepted` or `rejected`.
  for (const event of events) {
    if (!seen.has(event.event_id)) {
      accepted.push({ event_id: event.event_id, status: "accepted" });
    }
  }
  return { accepted, rejected };
}
