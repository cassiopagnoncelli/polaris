/**
 * Which way browser events reach the ingester.
 *
 *   direct — the Web SDK POSTs to the ingester itself. The key is
 *            publishable and travels in the bundle; the ingester defends it
 *            with the per-source origin allow-list and per-key rate limits.
 *
 *   relay  — the Web SDK POSTs to `/api/polaris/events` on this origin, and
 *            that route attaches the real key server-side. Nothing secret
 *            reaches the browser and there is no allow-list row to keep, but
 *            your servers are now in the path of event traffic.
 *
 * A real application picks one at build time and deletes the other. This
 * blueprint keeps both so the two can be compared against the same identity,
 * the same catalog, and the same Network tab — which is the one thing three
 * separate apps could never show.
 *
 * The choice lives in localStorage rather than a cookie deliberately: a
 * cookie would travel to the server on every request and start looking like
 * configuration, and it is not. It is a demo control.
 */

export type TransportMode = "direct" | "relay";

export const TRANSPORT_MODES: readonly TransportMode[] = ["direct", "relay"];

const STORAGE_KEY = "polaris_blueprint_transport";

function parse(value: string | undefined): TransportMode | undefined {
  return value === "direct" || value === "relay" ? value : undefined;
}

/**
 * Where a fresh browser starts.
 *
 * `direct`, because it is the smaller mental model — browser to ingester,
 * nothing in between — and because it is the mode that actually exercises
 * the origin allow-list `make setup` seeds. A wrong seed fails loudly on
 * first load instead of lying dormant behind the relay.
 */
export const DEFAULT_TRANSPORT_MODE: TransportMode =
  parse(process.env.NEXT_PUBLIC_POLARIS_TRANSPORT) ?? "direct";

/**
 * Read the stored choice. Safe to call on the server, where it reports the
 * default — but callers must still only call it from an effect, because a
 * server render that disagrees with the first client render is a hydration
 * mismatch.
 */
export function readTransportMode(): TransportMode {
  if (typeof window === "undefined") return DEFAULT_TRANSPORT_MODE;
  try {
    return parse(window.localStorage.getItem(STORAGE_KEY) ?? undefined) ?? DEFAULT_TRANSPORT_MODE;
  } catch {
    // Storage can throw outright in a locked-down or private-mode browser.
    return DEFAULT_TRANSPORT_MODE;
  }
}

export function writeTransportMode(mode: TransportMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Losing the preference across reloads beats failing the switch.
  }
}

/** Where each mode sends its batches. Shown in the UI, so keep it honest. */
export function endpointFor(mode: TransportMode): string {
  return mode === "relay"
    ? RELAY_PATH
    : (process.env.NEXT_PUBLIC_POLARIS_ENDPOINT ?? "http://localhost:4000/v1/events");
}

/** The relay route in this app. One literal, imported by both sides. */
export const RELAY_PATH = "/api/polaris/events";
