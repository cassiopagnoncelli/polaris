"use client";

import type { EnvelopeIdentity, IdentityDiagnostics } from "@polaris/web-sdk";
import { useEffect, useState, useSyncExternalStore } from "react";
import { getFeed, getServerFeed, subscribeToFeed } from "../lib/feed";
import { endpointFor } from "../lib/transport-mode";
import { usePolaris } from "./polaris-provider";

/**
 * What the SDK currently believes about this visitor.
 *
 * Worth having on screen for two reasons the blueprint depends on. First,
 * `anonymous_id` is what makes the browser and the backend the same person —
 * the server reads it out of the `polaris_id` cookie, so seeing it here and
 * seeing it echoed by a server checkout is the whole stitch, demonstrated.
 *
 * Second, `storage layer`. The cookie is only the SDK's preferred layer; if
 * it is unavailable the SDK falls back to localStorage, sessionStorage, then
 * memory. Those are invisible to the server, so the stitch stops working
 * with no error anywhere. This line is how you find that out.
 */
export function IdentityPanel() {
  const { sdk, mode } = usePolaris();
  const [envelope, setEnvelope] = useState<EnvelopeIdentity | null>(null);
  const [diagnostics, setDiagnostics] = useState<IdentityDiagnostics | null>(null);

  // Any SDK activity lands in the feed, so the feed doubles as a change
  // signal — cheaper and more accurate than polling on a timer.
  const feed = useSyncExternalStore(subscribeToFeed, getFeed, getServerFeed);

  // `feed` below is a change signal, not an input. Identity lives inside the
  // SDK and mutates in place, so there is nothing here for React to compare —
  // re-reading whenever the feed moves is what keeps this panel honest.
  // Taking the rule's advice and dropping it freezes the panel at whatever
  // the identity happened to be on mount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: change signal, see above
  useEffect(() => {
    if (sdk === null) {
      setEnvelope(null);
      setDiagnostics(null);
      return;
    }
    setEnvelope(sdk.getEnvelopeIdentity());
    setDiagnostics(sdk.getDiagnostics());
  }, [sdk, feed]);

  return (
    <div className="panel">
      <h3>Identity</h3>
      {envelope === null ? (
        <p className="muted">
          {mode === null
            ? "reading transport preference…"
            : "SDK not ready — see the activity feed"}
        </p>
      ) : (
        <dl className="kv">
          <dt>anonymous_id</dt>
          <dd>
            <code>{envelope.anonymous_id}</code>
          </dd>
          <dt>session_id</dt>
          <dd>
            <code>{envelope.session_id}</code>
          </dd>
          <dt>customer_id</dt>
          <dd>
            {envelope.customer_id === null ? (
              <span className="muted">null — nobody has called identify() yet</span>
            ) : (
              <code>{envelope.customer_id}</code>
            )}
          </dd>
          <dt>storage layer</dt>
          <dd>
            <code>{diagnostics?.currentLayer ?? "unknown"}</code>
            {diagnostics !== null && diagnostics.currentLayer !== "cookie" && (
              <span className="muted">
                {" "}
                — not a cookie, so the server cannot read this identity and backend events will not
                stitch
              </span>
            )}
          </dd>
          <dt>transport</dt>
          <dd>
            <code>{mode}</code>
            <span className="muted"> → {mode === null ? "…" : endpointFor(mode)}</span>
          </dd>
        </dl>
      )}
    </div>
  );
}
