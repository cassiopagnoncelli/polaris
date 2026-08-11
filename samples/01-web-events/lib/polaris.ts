"use client";

import type { Diagnostic, FlushResult, QueueEntry } from "@polaris/web-sdk";
import { HttpsTransport, PolarisWebSdk } from "@polaris/web-sdk";

/**
 * One SDK instance per browser tab.
 *
 * `PolarisWebSdk.create()` is async because it probes storage: IndexedDB for
 * the event queue (falling back to localStorage, then memory) and a
 * first-party cookie for identity (falling back to localStorage,
 * sessionStorage, then memory). Creating it twice would mean two queues and
 * two flush timers over the same identity, so the module holds the promise
 * and every caller awaits the same instance.
 */

const ENDPOINT = process.env.NEXT_PUBLIC_POLARIS_ENDPOINT ?? "http://localhost:4000/v1/events";
const API_KEY = process.env.NEXT_PUBLIC_POLARIS_API_KEY ?? "";
const SOURCE_ID = process.env.NEXT_PUBLIC_POLARIS_SOURCE_ID ?? "storefront-web";

let instance: Promise<PolarisWebSdk | null> | undefined;

/**
 * Resolves `null` when the sample is not configured yet. Every consumer
 * already handles a null SDK — the provider starts out null and the demo
 * panel disables itself on it — so an unconfigured sample renders and
 * explains itself instead of crashing.
 */
export function getPolaris(): Promise<PolarisWebSdk | null> {
  if (instance === undefined) {
    if (API_KEY === "") {
      // `HttpsTransport` throws from its constructor on an empty key, and
      // it is constructed as an argument below — so the throw escapes
      // `getPolaris()` synchronously, out of the provider's effect, and
      // takes down the tree with a stack pointing into SDK internals. A
      // missing key is an unfinished setup step, not a defect worth a
      // stack trace: say so where the sample already reports things.
      record(
        "NEXT_PUBLIC_POLARIS_API_KEY is not set — cp .env.example .env.local, then paste a web key",
      );
      instance = Promise.resolve(null);
      return instance;
    }
    instance = PolarisWebSdk.create({
      endpoint: ENDPOINT,
      apiKey: API_KEY,
      // `source.id` is a label the ingester overwrites with the identifier
      // bound to the API key. Keep it honest anyway — it shows up in logs
      // before the key is resolved.
      source: { id: SOURCE_ID },
      transport: new HttpsTransport({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        // Page-exit flushes prefer `navigator.sendBeacon`, which cannot set
        // request headers — so the beacon would reach the ingester without
        // `x-polaris-api-key` and be refused with 401. Returning false from
        // the beacon hook forces the `fetch(..., { keepalive: true })` path,
        // which does carry the header. Drop this override once you proxy
        // through your own origin (see samples/03-proxy-ingest).
        sendBeacon: () => false,
      }),
      diagnostics: {
        onFlush: (result: FlushResult) => {
          record(
            `flush (${result.mode}): delivered ${result.delivered}, queued ${result.queued}, dropped ${result.dropped}`,
          );
        },
        onDrop: (entry: QueueEntry, reason) => {
          record(`drop ${entry.payload.event} — ${reason}`);
        },
        onError: (error: Error) => {
          record(`error: ${error.message}`);
        },
        onDiagnostic: (diagnostic: Diagnostic) => {
          record(`${diagnostic.kind}: ${diagnostic.message}`);
        },
      },
    });
  }
  return instance;
}

// ---------------------------------------------------------------------------
// A tiny in-page activity feed so the sample can show what the SDK is doing.
// Nothing here is part of the SDK contract — real apps forward these
// callbacks to their own logger or metrics client.
// ---------------------------------------------------------------------------

export interface FeedEntry {
  readonly id: number;
  readonly at: string;
  readonly text: string;
}

const MAX_FEED_ENTRIES = 25;
const EMPTY_FEED: readonly FeedEntry[] = [];

let feed: readonly FeedEntry[] = EMPTY_FEED;
let nextId = 1;
const listeners = new Set<() => void>();

export function record(text: string): void {
  const entry: FeedEntry = {
    id: nextId++,
    at: new Date().toLocaleTimeString(),
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

/** Server render has no feed — returning a stable reference keeps React happy. */
export function getServerFeed(): readonly FeedEntry[] {
  return EMPTY_FEED;
}
