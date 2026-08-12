"use client";

import type { PolarisWebSdk } from "@polaris/web-sdk";
import Link from "next/link";
import { record } from "../lib/feed";
import { usePolaris } from "./polaris-provider";

/**
 * `track()`, four ways, against the same catalog.
 *
 * Two of these are accepted and two are refused, and the refusals are the
 * more useful half. The SDK holds no catalog and validates nothing — it
 * queues whatever you hand it. The ingester is the authority and answers per
 * event, so a retired version or a name nobody registered leaves the browser
 * looking exactly like a good one and comes back with a reason code. Watch
 * the drawer: the rejection arrives a flush later, tagged `drop`, permanent,
 * never retried.
 */

/** Money is carried in minor units — 2490 is BRL 24.90. */
const CART = {
  cart_id: "cart_overview",
  total: 2490,
  currency: "BRL",
  items: [{ sku: "MUG-001", name: "Polaris Mug", quantity: 1, unit_price: 2490 }],
  // Same event name as the three producers on /checkout. `flow_variant` is
  // what tells them apart once they are all in ClickHouse.
  flow_variant: "overview",
} as const;

export function EventPanel() {
  const { sdk } = usePolaris();

  /** Report the click first, then whatever the SDK made of it. */
  function emit(label: string, send: (ready: PolarisWebSdk) => Promise<string>): void {
    if (sdk === null) return;
    record("ui", `click: ${label}`);
    void send(sdk).then((eventId) => record("web", `track ${label} -> ${eventId}`));
  }

  return (
    <div className="panel">
      <div className="row">
        <button
          type="button"
          disabled={sdk === null}
          onClick={() =>
            emit("page.viewed v2", (ready) =>
              // The same call `PageViewTracker` makes on navigation, fired by
              // hand — because nothing about it is automatic.
              ready.track(
                "page.viewed",
                {
                  // Read off `location` rather than the router hooks: this
                  // runs on a click, so the live URL is the truth, and the
                  // component stays out of the `useSearchParams()` Suspense
                  // requirement that the tracker in the layout takes on.
                  path: window.location.pathname,
                  search: window.location.search.length > 0 ? window.location.search : null,
                  title: document.title,
                  referrer: document.referrer.length > 0 ? document.referrer : null,
                },
                { schemaVersion: 2 },
              ),
            )
          }
        >
          page.viewed
        </button>
        <button
          type="button"
          disabled={sdk === null}
          onClick={() =>
            emit("checkout.started", (ready) =>
              ready.track("checkout.started", { ...CART, items: [...CART.items] }),
            )
          }
        >
          checkout.started
        </button>
        <button
          type="button"
          className="danger"
          disabled={sdk === null}
          onClick={() =>
            emit("page.viewed v1 (sunset)", (ready) =>
              // v1 is registered, so the version resolves and the properties
              // fit — and the answer is still a rejection, because v1 is past
              // its `sunset_at`. A migration deadline, from the producer side.
              ready.track(
                "page.viewed",
                {
                  // v1's `path` carried the query string too — that
                  // conflation is why there is a v2.
                  path: `${window.location.pathname}${window.location.search}`,
                  title: document.title,
                  host: window.location.host,
                },
                { schemaVersion: 1 },
              ),
            )
          }
        >
          sunset version
        </button>
        <button
          type="button"
          className="danger"
          disabled={sdk === null}
          onClick={() =>
            emit("cart.abandoned (unregistered)", (ready) =>
              // Nothing registers this name, so it comes back
              // `unknown_event`. Adding an event is a catalog change, not a
              // client change — which is the point of having a catalog.
              ready.track("cart.abandoned", { cart_id: CART.cart_id }),
            )
          }
        >
          unknown event
        </button>
      </div>
      <p className="muted">
        The first two are accepted. The last two come back refused —{" "}
        <code>schema_version_sunset</code> and <code>unknown_event</code> — and the drawer shows it
        a flush later as <code>drop … permanent_failure</code>.{" "}
        <Link href="/learn#catalog">Why the browser cannot know first</Link>.
      </p>
    </div>
  );
}
