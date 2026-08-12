"use client";

import { record } from "../../lib/feed";
import { usePolaris } from "../polaris-provider";

/** Money is carried in minor units — 2490 is BRL 24.90. */
const CART = {
  cart_id: "cart_7f3a",
  total: 4470,
  currency: "BRL",
  items: [
    { sku: "MUG-001", name: "Polaris Mug", quantity: 1, unit_price: 2490 },
    { sku: "STK-014", name: "Sticker Pack", quantity: 2, unit_price: 990 },
  ],
  // Same event name as the two server producers below. `flow_variant` is
  // what tells them apart once they are all in ClickHouse.
  flow_variant: "browser",
} as const;

export function BrowserCheckout() {
  const { sdk } = usePolaris();

  return (
    <div className="row">
      <button
        type="button"
        disabled={sdk === null}
        onClick={() => {
          void sdk
            ?.track("checkout.started", { ...CART, items: [...CART.items] })
            .then((eventId) => record("web", `track checkout.started (browser) -> ${eventId}`));
        }}
      >
        checkout.started
      </button>
      <button
        type="button"
        disabled={sdk === null}
        onClick={() => {
          // `currency` must be a three-letter ISO 4217 code. The SDK does not
          // know that — only the ingester holds the catalog — so this leaves
          // the browser happily and comes back rejected.
          void sdk
            ?.track("checkout.started", {
              ...CART,
              items: [...CART.items],
              currency: "brazilian real",
            })
            .then((eventId) => record("web", `track invalid checkout.started -> ${eventId}`));
        }}
      >
        send an invalid one
      </button>
    </div>
  );
}
