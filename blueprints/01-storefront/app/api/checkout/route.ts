import { NextResponse } from "next/server";
import { getPolaris, identityFromCookies } from "../../../lib/polaris-node";

/**
 * `POST /api/checkout` — the classic backend producer.
 *
 * The Node SDK uses `node:https` and a long-lived queue, so this route must
 * run on the Node runtime, not the edge runtime.
 */
export const runtime = "nodejs";

interface CartItem {
  sku: string;
  name: string;
  quantity: number;
  unit_price: number;
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json()) as { cart_id?: string; items?: CartItem[] };
  const items = body.items ?? [];
  if (items.length === 0) {
    return NextResponse.json({ error: "cart is empty" }, { status: 400 });
  }

  const identity = await identityFromCookies();

  let polaris: ReturnType<typeof getPolaris>;
  try {
    polaris = getPolaris();
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }

  // track() returns as soon as the event is queued — it does not wait for
  // the network. The returned id is the UUIDv7 `event_id` the ingester will
  // answer with, so it is worth logging next to your order id.
  const eventId = await polaris.track(
    "checkout.started",
    {
      cart_id: body.cart_id ?? "cart_unknown",
      total: items.reduce((sum, item) => sum + item.unit_price * item.quantity, 0),
      currency: "BRL",
      items,
      flow_variant: "route-handler",
    },
    {
      identity,
      // The server knows things the browser should not be trusted for.
      context: { ip: clientIp(request), user_agent: request.headers.get("user-agent") },
    },
  );

  // Explicit flush before responding. On a long-running server the 5s
  // interval would get there eventually; on serverless the process is
  // frozen the moment the response is sent, and anything still queued
  // would be delivered late or not at all.
  const result = await polaris.flush();

  return NextResponse.json({
    event_id: eventId,
    delivered: result.delivered,
    still_queued: result.queued,
    stitched_anonymous_id: identity.anonymous_id,
  });
}

/**
 * Behind a proxy the socket address is the proxy's. Trust `x-forwarded-for`
 * only as far as you trust whoever sets it — in production, read the header
 * your own edge writes, not one a client can forge.
 */
function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded === null ? null : (forwarded.split(",")[0]?.trim() ?? null);
}
