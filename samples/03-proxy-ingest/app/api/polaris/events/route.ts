import { NextResponse } from "next/server";

/**
 * First-party relay: `POST /api/polaris/events` -> Polaris `POST /v1/events`.
 *
 * The browser talks only to this origin. What that buys:
 *
 *   - the API key stays on the server, so nobody lifts it out of a bundle
 *   - no `Origin` header reaches the ingester, so no allow-list row to
 *     maintain per environment — and no CORS preflight per batch
 *   - `context.ip` and `context.user_agent` are stamped from the connection
 *     instead of being trusted from the client
 *   - the path is first-party, which content blockers treat differently
 *     than a call to a separate analytics host
 *
 * What it costs: this route now carries your event traffic, and the origin
 * allow-list no longer defends the key. Rate limiting and abuse controls
 * are yours to add here.
 */

const ENDPOINT = process.env.POLARIS_ENDPOINT ?? "http://localhost:8080/v1/events";
const API_KEY = process.env.POLARIS_API_KEY ?? "";

/** The Web SDK batches at 20; anything much larger is not our SDK talking. */
const MAX_EVENTS_PER_BATCH = 50;

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  if (API_KEY === "") {
    return NextResponse.json({ error: "POLARIS_API_KEY is not set" }, { status: 500 });
  }

  // Read as text, not `request.json()`: a page-exit `sendBeacon` may arrive
  // with a `text/plain` content type, and the body is still JSON.
  let batch: unknown;
  try {
    batch = JSON.parse(await request.text());
  } catch {
    return NextResponse.json({ error: "body is not JSON" }, { status: 400 });
  }

  const events = (batch as { events?: unknown }).events;
  if (!Array.isArray(events) || events.length === 0) {
    return NextResponse.json({ error: "expected { events: [...] }" }, { status: 400 });
  }
  if (events.length > MAX_EVENTS_PER_BATCH) {
    return NextResponse.json({ error: "batch too large" }, { status: 413 });
  }

  const ip = clientIp(request);
  const userAgent = request.headers.get("user-agent");
  const stamped = events.map((event) => stampContext(event, ip, userAgent));

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-polaris-api-key": API_KEY,
    },
    body: JSON.stringify({ events: stamped }),
  });

  // Pass the ingester's answer through untouched. It reports acceptance per
  // event, and the SDK needs exactly that to decide what to retry, what to
  // drop as permanently rejected, and what to consider delivered.
  const body = await response.text();
  return new NextResponse(body, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
  });
}

function stampContext(event: unknown, ip: string | null, userAgent: string | null): unknown {
  if (event === null || typeof event !== "object") return event;
  const record = event as Record<string, unknown>;
  const context =
    record["context"] !== null && typeof record["context"] === "object"
      ? (record["context"] as Record<string, unknown>)
      : {};
  return { ...record, context: { ...context, ip, user_agent: userAgent } };
}

function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded === null ? null : (forwarded.split(",")[0]?.trim() ?? null);
}
