"use client";

import { useState, useSyncExternalStore } from "react";
import { clearFeed, getFeed, getServerFeed, subscribeToFeed } from "../lib/feed";

/**
 * Everything the blueprint has seen, newest first, in a drawer pinned to the
 * bottom of every page — so the feed stays put while you navigate, and the
 * page above it is free to be a page.
 *
 * Lines are tagged by producer: `web` for the browser SDK's own diagnostics,
 * `server` for what a Server Action or route handler reported back, and `ui`
 * for interactions that produced no event at all.
 *
 * The `web` lines are the SDK's diagnostic callbacks verbatim:
 * `onDiagnostic`, `onFlush`, `onDrop`, `onError`. The SDK never phones these
 * home and has no opinion about them — they are handed to whatever you pass
 * in. Here that is a module-level store feeding this list; in your app it
 * would be your logger or metrics client.
 */
export function ActivityDrawer() {
  const feed = useSyncExternalStore(subscribeToFeed, getFeed, getServerFeed);
  // Open by default: watching this list is the point of the blueprint. The
  // state lives in the layout, so it survives client-side navigation.
  const [open, setOpen] = useState(true);

  const latest = feed[0];

  return (
    <aside className="drawer" data-open={open} aria-label="Activity">
      <div className="drawer-head">
        <button
          type="button"
          className="drawer-toggle"
          aria-expanded={open}
          aria-controls="activity-body"
          onClick={() => setOpen((current) => !current)}
        >
          <span className="drawer-chevron" aria-hidden="true">
            ▾
          </span>
          <span className="drawer-label">Activity</span>
          <span className="drawer-count">{feed.length}</span>
          {!open && (
            <span className="drawer-peek">
              {latest === undefined ? (
                "nothing yet — navigate, or press a button"
              ) : (
                <>
                  <span className={`tag tag-${latest.channel}`}>{latest.channel}</span>
                  {latest.text}
                </>
              )}
            </span>
          )}
        </button>
        <button
          type="button"
          className="drawer-clear"
          disabled={feed.length === 0}
          onClick={clearFeed}
        >
          clear
        </button>
      </div>

      <div className="drawer-body" id="activity-body">
        {feed.length === 0 ? (
          <p className="muted drawer-empty">
            Nothing yet. Navigate, or press a button — every SDK diagnostic, every event, and every
            click lands here.
          </p>
        ) : (
          <ul className="feed">
            {feed.map((entry) => (
              <li key={entry.id}>
                <time>{entry.at}</time>
                <span className={`tag tag-${entry.channel}`}>{entry.channel}</span>
                <span>{entry.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
