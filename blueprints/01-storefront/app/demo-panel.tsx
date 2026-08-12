"use client";

import { useState } from "react";
import { record } from "../lib/feed";
import { usePolaris } from "./polaris-provider";

/**
 * The four public methods of the Web SDK, wired to buttons:
 * `track`, `identify`, `reset`, `flush`.
 *
 * `track` has its own page — see `/checkout`, where it carries a real
 * catalog schema. These three are the identity and delivery controls.
 */
export function DemoPanel() {
  const { sdk } = usePolaris();
  const [customerId, setCustomerId] = useState("cus_1042");

  return (
    <div className="panel">
      <div className="row">
        <input
          aria-label="customer id"
          value={customerId}
          onChange={(event) => setCustomerId(event.target.value)}
        />
        <button
          type="button"
          disabled={sdk === null}
          onClick={() => {
            // identify() attaches customer_id to every later event and
            // persists it in the same first-party store as anonymous_id.
            // It does not emit an event by itself.
            sdk?.identify(customerId);
            record("web", `identify(${customerId}) — watch the identity panel`);
          }}
        >
          identify
        </button>
        <button
          type="button"
          disabled={sdk === null}
          onClick={() => {
            // reset() clears customer_id and rotates session_id and
            // anonymous_id — the sign-out default. Pass
            // { anonymous: false } to keep anonymous continuity.
            sdk?.reset();
            record("web", "reset() — new anonymous_id and session_id, customer_id cleared");
          }}
        >
          reset (sign out)
        </button>
        <button
          type="button"
          disabled={sdk === null}
          onClick={() => {
            void sdk?.flush().then((result) => {
              record("web", `manual flush -> delivered ${result.delivered}`);
            });
          }}
        >
          flush now
        </button>
      </div>
      <p className="muted">
        Identity lives in a first-party cookie (mirrored to localStorage). Reload and the{" "}
        <code>anonymous_id</code> stays; <code>reset()</code> rotates it. Switching transport does
        not — the identity is in storage, not in the SDK object.
      </p>
    </div>
  );
}
