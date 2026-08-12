"use client";

import { useSyncExternalStore } from "react";
import { getFeed, getServerFeed, subscribeToFeed } from "../lib/feed";

/**
 * Everything the blueprint has seen, newest first, tagged by which path it
 * came from — `web` for the browser SDK's own diagnostics, `server` for what
 * a Server Action or route handler reported back.
 *
 * The `web` lines are the SDK's diagnostic callbacks verbatim:
 * `onDiagnostic`, `onFlush`, `onDrop`, `onError`. The SDK never phones these
 * home and has no opinion about them — they are handed to whatever you pass
 * in. Here that is a module-level store feeding this list; in your app it
 * would be your logger or metrics client.
 */
export function ActivityFeed() {
  const feed = useSyncExternalStore(subscribeToFeed, getFeed, getServerFeed);

  if (feed.length === 0) {
    return (
      <div className="panel">
        <p className="muted">Nothing yet. Navigate, or press a button.</p>
      </div>
    );
  }

  return (
    <div className="panel">
      <ul className="feed">
        {feed.map((entry) => (
          <li key={entry.id}>
            <time>{entry.at}</time>
            <span className={`tag tag-${entry.channel}`}>{entry.channel}</span>
            <span>{entry.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
