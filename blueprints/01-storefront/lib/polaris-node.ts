import "server-only";

import { PolarisNodeSdk } from "@polaris/node-sdk";
import { cookies } from "next/headers";

/**
 * One Node SDK per server process.
 *
 * The instance owns a queue, a flush interval, and a keep-alive HTTP agent,
 * so it must outlive a single request. In development Next reloads modules
 * on every edit, which would leak an SDK (and its timer) per reload — hence
 * the globalThis cache, the same trick used for database clients.
 *
 * This is a different key from the browser's. The Web SDK sends a *web* key
 * that is publishable and origin-scoped; this sends a *backend* key that is
 * neither. They are also different sources in the catalog — `storefront-web`
 * and `payments-api` — which is what lets a query separate "the browser said
 * so" from "the server confirmed it".
 */

const globalForPolaris = globalThis as typeof globalThis & {
  __polaris?: PolarisNodeSdk;
};

export function getPolaris(): PolarisNodeSdk {
  if (globalForPolaris.__polaris === undefined) {
    const apiKey = process.env.POLARIS_BACKEND_API_KEY;
    if (apiKey === undefined || apiKey === "") {
      throw new Error(
        "POLARIS_BACKEND_API_KEY is not set — run `make setup`, which issues it into " +
          "the generated .env.<mode>.local files",
      );
    }
    globalForPolaris.__polaris = new PolarisNodeSdk({
      endpoint: process.env.POLARIS_ENDPOINT ?? "http://localhost:4000/v1/events",
      apiKey,
      source: {
        type: "backend",
        id: process.env.POLARIS_BACKEND_SOURCE_ID ?? "payments-api",
      },
      // Opt in to SIGTERM/SIGINT handlers that drain the queue before the
      // process dies. Off by default because a library has no business
      // installing signal handlers behind your back.
      autoFlushOnShutdown: true,
      shutdownTimeoutMs: 3_000,
      diagnostics: {
        onFlush: (result) => {
          // The steady interval fires every 5s whether or not there is work,
          // so an unfiltered log here is a heartbeat nobody asked for.
          if (result.delivered === 0 && result.dropped === 0) return;
          console.log(`[polaris] flush delivered=${result.delivered} queued=${result.queued}`);
        },
        onDrop: (event, reason) => {
          console.warn(`[polaris] dropped ${event.event} (${event.event_id}): ${reason}`);
        },
        onError: (error) => {
          console.error("[polaris] error", error);
        },
      },
    });
  }
  return globalForPolaris.__polaris;
}

export interface StitchedIdentity {
  readonly anonymous_id: string | null;
  readonly session_id: string | null;
  readonly customer_id: string | null;
}

const EMPTY_IDENTITY: StitchedIdentity = {
  anonymous_id: null,
  session_id: null,
  customer_id: null,
};

/**
 * The stitch: read the browser's identity so backend events join it.
 *
 * Backend events carry whatever identity the caller hands them — the Node
 * SDK never infers one. The Web SDK persists `anonymous_id`, `session_id`
 * and `customer_id` as one JSON record in a first-party `polaris_id` cookie
 * (see `packages/web-sdk/src/identity/serialize.ts`), and a first-party
 * cookie is readable here. Read it, pass it to `track()`, and the browser's
 * `page.viewed` and this process's `checkout.started` land on the same
 * visitor instead of looking like two strangers.
 *
 * The caveat worth knowing: the cookie is only the SDK's *preferred* layer.
 * If cookies are unavailable it falls back to localStorage, sessionStorage,
 * then memory — none of which the server can read, and the stitch silently
 * stops working. The identity panel on the home page shows which layer is
 * actually in use, which is why it is there.
 *
 * A backend with no browser in front of it — a webhook, a cron job — skips
 * all of this and passes its own identifiers, or none.
 */
export async function identityFromCookies(): Promise<StitchedIdentity> {
  const raw = (await cookies()).get("polaris_id")?.value;
  if (raw === undefined) return EMPTY_IDENTITY;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(raw));
    if (parsed === null || typeof parsed !== "object") throw new Error("not an object");
    const record = parsed as Record<string, unknown>;
    return {
      anonymous_id: typeof record["anonymous_id"] === "string" ? record["anonymous_id"] : null,
      session_id: typeof record["session_id"] === "string" ? record["session_id"] : null,
      customer_id: typeof record["customer_id"] === "string" ? record["customer_id"] : null,
    };
  } catch {
    // A corrupt or foreign cookie is not worth failing a checkout over.
    return EMPTY_IDENTITY;
  }
}
