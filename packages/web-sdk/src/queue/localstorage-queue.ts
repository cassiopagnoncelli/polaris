/**
 * `localStorage`-backed event queue.
 *
 * Per `docs/architecture/10-sdk-standards.md`:
 *
 *   IndexedDB preferred
 *   localStorage fallback
 *   memory fallback
 *
 * localStorage is the fallback when IndexedDB is unavailable (typical for
 * some private-browsing modes, ad WebViews, and SafeBrowsing-locked
 * iframes). It is synchronous, string-only, capped at ~5-10MB depending
 * on the browser, and shared across all tabs of the same origin. The
 * shared-across-tabs property is intentional for an event queue: if the
 * user has the same site open in two tabs we want both tabs' events to
 * survive a refresh even if only one tab is in the eager-flush window.
 *
 * Serialization shape: a single JSON-encoded array under `polaris_queue`.
 * One array (rather than one key per event) keeps writes atomic — a
 * partial write that fails leaves the queue intact instead of half-empty.
 * The cost is rewriting the full payload on every enqueue, which is
 * acceptable because `maxSize` is bounded at ~1000 events.
 */

import type { EnqueueOutcome, EventQueue, QueueEntry, QueueLayer } from "../types.js";
import { pickEvictionIndex } from "./priority.js";

const DEFAULT_KEY = "polaris_queue";

export interface LocalStorageQueueOptions {
  readonly storage: Storage | undefined;
  readonly maxSize: number;
  readonly key?: string;
}

interface PersistedQueue {
  readonly version: 1;
  readonly entries: QueueEntry[];
}

export class LocalStorageQueue implements EventQueue {
  public readonly layer: QueueLayer = "localstorage";
  private readonly storage: Storage;
  private readonly maxSize: number;
  private readonly key: string;

  public constructor(options: LocalStorageQueueOptions) {
    if (!Number.isInteger(options.maxSize) || options.maxSize <= 0) {
      throw new Error("LocalStorageQueue requires a positive integer maxSize");
    }
    if (options.storage === undefined) {
      throw new Error("LocalStorageQueue: storage is required");
    }
    this.storage = options.storage;
    this.maxSize = options.maxSize;
    this.key = options.key ?? DEFAULT_KEY;
  }

  public enqueue(entry: QueueEntry): Promise<EnqueueOutcome> {
    const entries = this.readAll();
    if (entries.length < this.maxSize) {
      entries.push(entry);
      this.writeAll(entries);
      return Promise.resolve({ status: "accepted" });
    }
    const evictIdx = pickEvictionIndex(entries, entry);
    if (evictIdx === -1) {
      return Promise.resolve({ status: "rejected" });
    }
    const [evicted] = entries.splice(evictIdx, 1);
    entries.push(entry);
    this.writeAll(entries);
    return Promise.resolve({
      status: "accepted_with_drops",
      dropped: evicted === undefined ? [] : [evicted],
    });
  }

  public size(): Promise<number> {
    return Promise.resolve(this.readAll().length);
  }

  public drain(max: number): Promise<QueueEntry[]> {
    if (max <= 0) return Promise.resolve([]);
    const entries = this.readAll();
    if (entries.length === 0) return Promise.resolve([]);
    const slice = entries.splice(0, Math.min(max, entries.length));
    this.writeAll(entries);
    return Promise.resolve(slice);
  }

  public drainAll(): Promise<QueueEntry[]> {
    const entries = this.readAll();
    if (entries.length === 0) return Promise.resolve([]);
    this.writeAll([]);
    return Promise.resolve(entries);
  }

  public requeue(entries: readonly QueueEntry[]): Promise<void> {
    if (entries.length === 0) return Promise.resolve();
    const current = this.readAll();
    const combined = [...entries, ...current];
    if (combined.length > this.maxSize) {
      combined.length = this.maxSize;
    }
    this.writeAll(combined);
    return Promise.resolve();
  }

  private readAll(): QueueEntry[] {
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.key);
    } catch {
      return [];
    }
    if (raw === null || raw.length === 0) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== "object") return [];
      const candidate = parsed as Partial<PersistedQueue>;
      if (!Array.isArray(candidate.entries)) return [];
      // Defensive: trust the shape but drop entries that fail a basic shape
      // check rather than crashing the SDK on a cross-version payload.
      return candidate.entries.filter(isQueueEntryShape);
    } catch {
      return [];
    }
  }

  private writeAll(entries: readonly QueueEntry[]): void {
    const payload: PersistedQueue = { version: 1, entries: [...entries] };
    try {
      this.storage.setItem(this.key, JSON.stringify(payload));
    } catch {
      // Quota exceeded or SecurityError: best-effort. The next `readAll`
      // will return the previous good state. The SDK does NOT throw on
      // queue overflow per the architecture doc.
    }
  }
}

function isQueueEntryShape(value: unknown): value is QueueEntry {
  if (value === null || typeof value !== "object") return false;
  const v = value as Partial<QueueEntry>;
  if (typeof v.priority !== "string") return false;
  if (typeof v.attempts !== "number") return false;
  if (typeof v.enqueued_at !== "number") return false;
  if (typeof v.payload !== "object" || v.payload === null) return false;
  const p = v.payload as Partial<QueueEntry["payload"]>;
  if (typeof p.event_id !== "string" || p.event_id.length === 0) return false;
  if (typeof p.event !== "string" || p.event.length === 0) return false;
  return true;
}
