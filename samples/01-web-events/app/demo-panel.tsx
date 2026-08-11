"use client";

import { useState, useSyncExternalStore } from "react";
import { getFeed, getServerFeed, record, subscribeToFeed } from "../lib/polaris";
import { usePolaris } from "./polaris-provider";

/**
 * The four public methods of the Web SDK, wired to buttons:
 * `track`, `identify`, `reset`, `flush`.
 */
export function DemoPanel() {
  const sdk = usePolaris();
  const [customerId, setCustomerId] = useState("cus_1042");
  const feed = useSyncExternalStore(subscribeToFeed, getFeed, getServerFeed);

  return (
    <>
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
              record(`identify(${customerId})`);
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
              record("reset()");
            }}
          >
            reset (sign out)
          </button>
          <button
            type="button"
            disabled={sdk === null}
            onClick={() => {
              void sdk?.flush().then((result) => {
                record(`manual flush -> delivered ${result.delivered}`);
              });
            }}
          >
            flush now
          </button>
        </div>
        <p className="muted">
          Identity lives in a first-party cookie (mirrored to localStorage). Reload the page and the{" "}
          <code>anonymous_id</code> stays; <code>reset()</code> rotates it.
        </p>
      </div>

      <h2>SDK activity</h2>
      <p className="muted">
        Diagnostic callbacks — <code>onDiagnostic</code>, <code>onFlush</code>, <code>onDrop</code>,{" "}
        <code>onError</code>. The SDK never phones these home; they are yours to log.
      </p>
      <div className="panel">
        {feed.length === 0 ? (
          <p className="muted">Nothing yet. Navigate, or press a button above.</p>
        ) : (
          <ul className="feed">
            {feed.map((entry) => (
              <li key={entry.id}>
                <time>{entry.at}</time>
                <span>{entry.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
