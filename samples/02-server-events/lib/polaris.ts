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
 */

const globalForPolaris = globalThis as typeof globalThis & {
  __polaris?: PolarisNodeSdk;
};

export function getPolaris(): PolarisNodeSdk {
  if (globalForPolaris.__polaris === undefined) {
    const apiKey = process.env.POLARIS_API_KEY;
    if (apiKey === undefined || apiKey === "") {
      throw new Error("POLARIS_API_KEY is not set — copy .env.example to .env.local");
    }
    globalForPolaris.__polaris = new PolarisNodeSdk({
      endpoint: process.env.POLARIS_ENDPOINT ?? "http://localhost:8080/v1/events",
      apiKey,
      source: {
        type: "backend",
        id: process.env.POLARIS_SOURCE_ID ?? "payments-api",
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

/**
 * Backend events carry whatever identity the caller hands them — the Node
 * SDK never infers one. When the same visitor also runs the Web SDK, its
 * first-party `polaris_id` cookie is the stitch: read it here and the
 * browser's `page.viewed` and this process's `checkout.started` land on the
 * same `anonymous_id` and `session_id`.
 *
 * A backend with no browser in front of it (a webhook, a cron job) simply
 * skips this and passes its own identifiers, or none at all.
 */
export async function identityFromCookies(): Promise<{
  anonymous_id: string | null;
  session_id: string | null;
  customer_id: string | null;
}> {
  const raw = (await cookies()).get("polaris_id")?.value;
  if (raw === undefined) return { anonymous_id: null, session_id: null, customer_id: null };
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(raw));
    if (parsed === null || typeof parsed !== "object") throw new Error("not an object");
    const record = parsed as Record<string, unknown>;
    return {
      anonymous_id: typeof record.anonymous_id === "string" ? record.anonymous_id : null,
      session_id: typeof record.session_id === "string" ? record.session_id : null,
      customer_id: typeof record.customer_id === "string" ? record.customer_id : null,
    };
  } catch {
    // A corrupt or foreign cookie is not worth failing a checkout over.
    return { anonymous_id: null, session_id: null, customer_id: null };
  }
}
