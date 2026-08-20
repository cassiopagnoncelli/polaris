import type { BatchRejectedResult } from "@polaris/spec";
/**
 * Default HTTPS POST transport for `@polaris/node-sdk`.
 *
 * Per `docs/architecture/04-ingestion-and-sdks.md`:
 *   "send over HTTPS to the ingester"
 *
 * Implementation notes:
 *
 *   - Uses Node's built-in `https.request` with an `Agent({ keepAlive: true })`
 *     to amortize TLS over batch flushes without pulling in a heavy HTTP
 *     client dependency.
 *   - Plain `http://` URLs are supported so operators can wire the SDK
 *     against a local ingester behind a TLS-terminating proxy in dev/test.
 *     The default expectation in production is HTTPS.
 *   - Treats `2xx` as accepted, `4xx` as permanent (non-retryable, per the
 *     RFC 7807 contract for request-level failures), and `5xx`/network
 *     errors as transient (retryable).
 *   - Parses the ingester's per-event batch response shape
 *     (`accepted[]` / `rejected[]`) per `04-ingestion-and-sdks.md`. If
 *     the response cannot be parsed but the status was 2xx, all events
 *     are treated as accepted (the ingester explicitly returns a body,
 *     so this is defensive only).
 */

import { Agent as HttpAgent, request as httpRequest, type RequestOptions } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { URL } from "node:url";
import type { QueuedEvent, Transport, TransportEventResult, TransportResult } from "../types.js";

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
  readonly userAgent: string;
  readonly requestTimeoutMs: number;
}

/**
 * The ingester's per-event entry, as it actually goes over the wire.
 *
 * Derived from the server's own `batchRejectedResultSchema` rather than
 * hand-written. The previous local mirror declared `reason?: string` — a field
 * the ingester has never sent — and omitted `code` and `retryable`, which it
 * does. TypeScript agreed with the mirror because a mirror is what it was
 * checking against, so the two sides of this contract disagreed silently and
 * every rejection was classified permanent.
 */
type BatchResponseEntry = Partial<BatchRejectedResult> & {
  readonly event_id: string;
  readonly status: "accepted" | "rejected";
  /** Retained so an older ingester that sent `reason` still parses. */
  readonly reason?: string;
};

interface BatchResponse {
  readonly accepted?: readonly BatchResponseEntry[];
  readonly rejected?: readonly BatchResponseEntry[];
}

/**
 * Reasons the ingester returns that are operationally permanent — the
 * producer has a bug we want them to fix, not a transient blip. SDKs must
 * not retry these (per `09-engineering-standards.md` "SDKs must not retry
 * permanent validation failures").
 */
/**
 * Fallback classification, used only when the ingester did not send
 * `retryable` — i.e. against an older deployment. The server is the source of
 * truth (`isRetryableBatchReason`); duplicating the rule here is how the two
 * drift, so this set exists purely for compatibility and must not grow.
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

export class HttpsTransport implements Transport {
  private readonly endpoint: URL;
  private readonly apiKey: string;
  private readonly userAgent: string;
  private readonly requestTimeoutMs: number;
  private readonly httpsAgent: HttpsAgent;
  private readonly httpAgent: HttpAgent;

  public constructor(options: HttpsTransportOptions) {
    this.endpoint = new URL(options.endpoint);
    if (this.endpoint.protocol !== "https:" && this.endpoint.protocol !== "http:") {
      throw new Error(`HttpsTransport endpoint must be http(s); got ${this.endpoint.protocol}`);
    }
    this.apiKey = options.apiKey;
    this.userAgent = options.userAgent;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.httpsAgent = new HttpsAgent({ keepAlive: true });
    this.httpAgent = new HttpAgent({ keepAlive: true });
  }

  public async send(events: readonly QueuedEvent[]): Promise<TransportResult> {
    const payload = Buffer.from(JSON.stringify({ events }));
    const isHttps = this.endpoint.protocol === "https:";
    const requestFn = isHttps ? httpsRequest : httpRequest;
    const agent = isHttps ? this.httpsAgent : this.httpAgent;
    const portString = this.endpoint.port;
    const defaultPort = isHttps ? 443 : 80;
    const requestOptions: RequestOptions = {
      method: "POST",
      hostname: this.endpoint.hostname,
      port: portString === "" ? defaultPort : Number(portString),
      path: `${this.endpoint.pathname}${this.endpoint.search}`,
      agent,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(payload.byteLength),
        // Ingester auth contract: the API key travels in the
        // `x-polaris-api-key` header as `<api_key_id>.<secret>` (see
        // apps/ingester-api/src/auth/api-key.ts; the ingester does not
        // read `Authorization: Bearer` — that header is reserved for the
        // control-plane operator-token flow, a separate auth surface).
        "x-polaris-api-key": this.apiKey,
        "User-Agent": this.userAgent,
        Accept: "application/json",
      },
    };

    return await new Promise<TransportResult>((resolve, reject) => {
      const req = requestFn(requestOptions, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            resolve(parseBatchResponse(events, body));
            return;
          }
          if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
            reject(
              new TransportError(`ingester returned ${status}`, {
                retryable: false,
                status,
              }),
            );
            return;
          }
          // 5xx, 408 (timeout), 429 (rate limit) are retryable.
          reject(
            new TransportError(`ingester returned ${status}`, {
              retryable: true,
              status,
            }),
          );
        });
      });

      req.on("error", (err: Error & { code?: string }) => {
        const code = err.code;
        reject(
          new TransportError(`transport error: ${err.message}`, {
            retryable: true,
            ...(code !== undefined ? { code } : {}),
          }),
        );
      });

      req.setTimeout(this.requestTimeoutMs, () => {
        req.destroy(
          new TransportError(`request timed out after ${this.requestTimeoutMs}ms`, {
            retryable: true,
            code: "ETIMEDOUT",
          }),
        );
      });

      req.write(payload);
      req.end();
    });
  }

  public close(): void {
    this.httpsAgent.destroy();
    this.httpAgent.destroy();
  }
}

function parseBatchResponse(events: readonly QueuedEvent[], body: string): TransportResult {
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
      // Fall through; treat all events as accepted given the 2xx status.
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
    // The wire field is `code` (see `batchRejectedResultSchema`). Reading
    // `entry.reason` — which the ingester has never sent — left `reason`
    // undefined on every rejection, so the expression below evaluated to
    // `retryable: false` for ALL of them and this SDK dropped every event the
    // ingester asked it to retry, including `publish_failed`.
    const reason = entry.code ?? entry.reason;
    const retryable =
      // The server decides. Only fall back to the local set when it said
      // nothing, which means an ingester older than the `retryable` field.
      typeof entry.retryable === "boolean"
        ? entry.retryable
        : reason !== undefined && !PERMANENT_REJECTION_REASONS.has(reason);
    rejected.push({
      event_id: entry.event_id,
      status: "rejected",
      ...(reason !== undefined ? { reason } : {}),
      retryable,
    });
  }
  // Events the ingester did not echo back are treated as accepted to
  // avoid duplicating them on retry. This matches the ingester contract:
  // a per-event entry must always be returned.
  for (const event of events) {
    if (!seen.has(event.event_id)) {
      accepted.push({ event_id: event.event_id, status: "accepted" });
    }
  }
  return { accepted, rejected };
}
