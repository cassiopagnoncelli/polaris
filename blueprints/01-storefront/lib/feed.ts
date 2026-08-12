"use client";

/**
 * A tiny in-page activity feed so the blueprint can show what the SDK is
 * doing without asking you to keep DevTools open.
 *
 * Nothing here is part of the SDK contract. The SDK reports through the
 * diagnostic callbacks it is handed; a real app forwards those to its own
 * logger or metrics client. This module is what the callbacks are wired to
 * so the page can render them.
 *
 * It is a module-level store rather than React state because the SDK is a
 * module-level singleton too: events arrive from callbacks that are not
 * inside any component, sometimes before the tree has mounted.
 */

/**
 * Who produced a line.
 *
 * `web`, `server`, and `relay` are reports about events Polaris actually
 * saw. `ui` is the odd one out on purpose: it is something this page did —
 * a click, a route change, a control flipped — that produced no event at
 * all. Keeping it in the same list, under its own tag, is what makes the
 * boundary visible: an interaction is not an event until you track one.
 */
export type FeedChannel = "web" | "server" | "relay" | "ui";

export interface FeedEntry {
  readonly id: number;
  readonly at: string;
  readonly channel: FeedChannel;
  readonly text: string;
}

const MAX_FEED_ENTRIES = 80;
const EMPTY_FEED: readonly FeedEntry[] = [];

let feed: readonly FeedEntry[] = EMPTY_FEED;
let nextId = 1;
const listeners = new Set<() => void>();

export function record(channel: FeedChannel, text: string): void {
  const entry: FeedEntry = {
    id: nextId++,
    at: new Date().toLocaleTimeString(),
    channel,
    text,
  };
  feed = [entry, ...feed].slice(0, MAX_FEED_ENTRIES);
  for (const listener of listeners) listener();
}

/** Empty the list. A demo affordance — nothing upstream is affected. */
export function clearFeed(): void {
  feed = EMPTY_FEED;
  for (const listener of listeners) listener();
}

export function subscribeToFeed(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getFeed(): readonly FeedEntry[] {
  return feed;
}

/**
 * Server render has no feed. `useSyncExternalStore` compares snapshots by
 * reference, so this has to be the same empty array every call — returning
 * a fresh `[]` would loop forever.
 */
export function getServerFeed(): readonly FeedEntry[] {
  return EMPTY_FEED;
}
