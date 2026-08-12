"use client";

import { record } from "../../lib/feed";
import { endpointFor, TRANSPORT_MODES } from "../../lib/transport-mode";
import { usePolaris } from "../polaris-provider";

/**
 * Flip the browser between the direct and relayed paths.
 *
 * The switch closes the current SDK and builds a new one — see
 * `lib/polaris-web.ts`. Two things are worth watching while you use it:
 *
 *   - the Network tab. Direct mode posts cross-origin to the ingester with
 *     `x-polaris-api-key` visible in the request; relay mode posts
 *     same-origin to this app, and the key is nowhere in the browser.
 *   - the identity panel. `anonymous_id` does not change. Identity is in the
 *     first-party cookie, not in the SDK instance, so replacing the instance
 *     does not touch the visitor.
 *
 * Buttons stay enabled during a swap: swaps are serialized in the module, so
 * an impatient double-click queues rather than races.
 */
export function TransportSwitch() {
  const { mode, setMode, sdk } = usePolaris();

  return (
    <div className="panel">
      <div className="row">
        {TRANSPORT_MODES.map((candidate) => (
          <button
            key={candidate}
            type="button"
            aria-pressed={mode === candidate}
            className={mode === candidate ? "active" : undefined}
            onClick={() => {
              record("ui", `click: transport → ${candidate}`);
              setMode(candidate);
            }}
          >
            {candidate}
          </button>
        ))}
        <span className="muted">
          {mode === null ? (
            "reading preference…"
          ) : (
            <>
              posting to <code>{endpointFor(mode)}</code>
              {sdk === null && " — not ready, see the activity feed"}
            </>
          )}
        </span>
      </div>
    </div>
  );
}
