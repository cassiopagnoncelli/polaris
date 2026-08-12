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

export type FeedChannel = "web" | "server" | "relay";

export interface FeedEntry {
  readonly id: number;
  readonly at: string;
  readonly channel: FeedChannel;
  readonly text: string;
}

const MAX_FEED_ENTRIES = 40;
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
