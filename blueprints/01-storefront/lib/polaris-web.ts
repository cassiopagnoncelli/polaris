"use client";

import type { Diagnostic, FlushResult, PolarisWebSdk, QueueEntry } from "@polaris/web-sdk";
import { HttpsTransport, PolarisWebSdk as WebSdk } from "@polaris/web-sdk";
import { record } from "./feed";
import { endpointFor, RELAY_PATH, type TransportMode } from "./transport-mode";

/**
 * One Web SDK instance per browser tab — and exactly one.
 *
 * `WebSdk.create()` is async because it probes storage: IndexedDB for the
 * event queue (falling back to localStorage, then memory) and a first-party
 * cookie for identity (falling back to localStorage, sessionStorage, then
 * memory). Creating it twice would mean two queues and two flush timers over
 * one identity, so the module holds the instance and every caller shares it.
 *
 * Switching transport is therefore a *replacement*, not a second instance:
 * close the old one — which drains it best-effort — and build the new one.
 * Identity survives the swap untouched, because it lives in the first-party
 * cookie rather than in the object. That is worth watching in the identity
 * panel: the `anonymous_id` does not move when the transport does.
 */

const SOURCE_ID = process.env.NEXT_PUBLIC_POLARIS_SOURCE_ID ?? "storefront-web";

/**
 * The publishable key, present only when the direct path is configured.
 *
 * `NEXT_PUBLIC_` means "inlined into the browser bundle". That is correct
 * for a web key — the ingester scopes it to an origin allow-list and rate
 * limits it per key — and never correct for a backend key. Leaving this
 * empty is a legitimate configuration: the relay path needs no browser key
 * at all, and direct mode then reports itself unavailable instead of
 * pretending.
 */
const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_POLARIS_API_KEY ?? "";

/**
 * What the relay sends as `x-polaris-api-key` before the server replaces it.
 *
 * `HttpsTransport` requires a non-empty key and sets the header from it, so
 * the browser has to send *something*. The relay overwrites the header with
 * the real key, so this string is never authenticated against anything.
 */
const RELAY_PLACEHOLDER_KEY = "relayed-by-the-server";

let currentMode: TransportMode | undefined;
let currentSdk: Promise<PolarisWebSdk | null> | undefined;

/**
 * Swaps are serialized through this chain.
 *
 * Two rapid clicks on the transport switch would otherwise interleave a
 * close and a create over the same module state, and the loser would leave
 * a live instance nobody holds a reference to — a queue and a timer running
 * against an identity the page has stopped using.
 */
let chain: Promise<unknown> = Promise.resolve();

/**
 * The instance for `mode`, building or replacing it if needed.
 *
 * Resolves `null` when the selected mode is not configured. Every caller
 * already handles null — the provider starts null and the panels disable
 * themselves on it — so an unconfigured blueprint renders and explains
 * itself rather than crashing with a stack pointing into SDK internals.
 */
export function getPolaris(mode: TransportMode): Promise<PolarisWebSdk | null> {
  const result = chain.then(() => swapTo(mode));
  // Keep the chain alive past a rejection: one failed create must not wedge
  // every later switch.
  chain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function swapTo(mode: TransportMode): Promise<PolarisWebSdk | null> {
  if (currentMode === mode && currentSdk !== undefined) return currentSdk;

  if (currentSdk !== undefined) {
    const previous = await currentSdk;
    if (previous !== null) {
      // close() stops the lifecycle hooks, then flushes urgently on a
      // best-effort basis before tearing down queue and transport. Anything
      // still queued at that point is gone — which is the honest cost of
      // swapping transports mid-session, and why a real app picks one.
      await previous.close();
      record("web", `closed the ${currentMode} transport (drained best-effort)`);
    }
  }

  currentMode = mode;
  currentSdk = create(mode);
  return currentSdk;
}

async function create(mode: TransportMode): Promise<PolarisWebSdk | null> {
  const endpoint = endpointFor(mode);

  if (mode === "direct" && PUBLISHABLE_KEY === "") {
    // `HttpsTransport` throws from its constructor on an empty key, and it
    // is constructed as an argument below — so the throw would escape here
    // synchronously, out of the provider's effect, and take the tree down.
    // A missing key is an unfinished setup step, not a defect worth a stack
    // trace: say so where the blueprint already reports things.
    record(
      "web",
      "direct mode needs NEXT_PUBLIC_POLARIS_API_KEY — uncomment it in .env.local " +
        "(it references the issued token), or stay on relay",
    );
    return null;
  }

  const apiKey = mode === "direct" ? PUBLISHABLE_KEY : RELAY_PLACEHOLDER_KEY;

  const sdk = await WebSdk.create({
    endpoint,
    apiKey,
    // `source.id` is a label the ingester overwrites with the identifier
    // bound to the API key. Keep it honest anyway — it shows up in logs
    // before the key is resolved.
    source: { id: SOURCE_ID },
    transport: new HttpsTransport({
      endpoint,
      apiKey,
      // Page-exit flushes prefer `navigator.sendBeacon`, which cannot set
      // request headers. Direct mode authenticates with a header, so a
      // beacon would arrive at the ingester without `x-polaris-api-key` and
      // be refused 401 — returning false forces the
      // `fetch(..., { keepalive: true })` path, which does carry it.
      //
      // The relay has no such problem: it authenticates on the server, so
      // there is no header to lose and beacons are left enabled. This one
      // line is the clearest mechanical difference between the two paths.
      ...(mode === "direct" ? { sendBeacon: () => false } : {}),
    }),
    diagnostics: {
      onFlush: (result: FlushResult) => {
        // The steady timer fires every 5 seconds whether or not anything is
        // waiting. Your logger wants those — an empty flush is still proof
        // the timer is alive. A drawer a human is reading does not: a
        // metronome of `delivered 0, queued 0, dropped 0` buries the lines
        // that mean something. Report movement only.
        if (
          result.mode === "steady" &&
          result.delivered === 0 &&
          result.queued === 0 &&
          result.dropped === 0
        ) {
          return;
        }
        record(
          "web",
          `flush (${result.mode}) via ${mode}: delivered ${result.delivered}, queued ${result.queued}, dropped ${result.dropped}`,
        );
      },
      onDrop: (entry: QueueEntry, reason) => {
        record("web", `drop ${entry.payload.event} — ${reason}`);
      },
      onError: (error: Error) => {
        record("web", `error: ${error.message}`);
      },
      onDiagnostic: (diagnostic: Diagnostic) => {
        record("web", `${diagnostic.kind}: ${diagnostic.message}`);
      },
    },
  });

  record(
    "web",
    mode === "relay"
      ? `web sdk ready — batching to ${RELAY_PATH} on this origin`
      : `web sdk ready — batching straight to ${endpoint}`,
  );
  return sdk;
}
