/**
 * IndexedDB-backed event queue.
 *
 * The preferred queue layer per `docs/architecture/10-sdk-standards.md`:
 *
 *   IndexedDB preferred
 *   localStorage fallback
 *   memory fallback
 *
 * IndexedDB wins for queues because it is:
 *
 *   - asynchronous (does not block the main thread on writes)
 *   - large (hundreds of MB to GB of quota in modern browsers)
 *   - structured (we can read records back as typed objects, not strings)
 *   - durable across reloads (the canonical offline-first surface)
 *
 * Schema:
 *
 *   database name:   `polaris_web_sdk`
 *   object store:    `events`
 *   key path:        `event_id` (UUIDv7 — time-ordered so the natural
 *                    sort by primary key is roughly FIFO across sessions)
 *
 * Each record is a `QueueEntry` (payload + priority + attempts +
 * enqueued_at). We do NOT split the payload across multiple stores;
 * everything the SDK needs to retry an event lives in one record so a
 * partial read failure does not lose retry context.
 *
 * Determinism: the queue uses cursor traversal in primary-key order to
 * approximate FIFO. UUIDv7 is monotonic-ish (millisecond-precision time
 * prefix + random tail), so primary-key order is effectively enqueue
 * order without an explicit sequence field. The trailing random bits can
 * reorder events within the same millisecond, but that is acceptable for
 * a retry queue — the ingester is the canonical ordering authority via
 * `occurred_at` and `event_id`.
 */

import type { EnqueueOutcome, EventQueue, QueueEntry, QueueLayer } from "../types.js";
import { pickEvictionIndex } from "./priority.js";

const DEFAULT_DB_NAME = "polaris_web_sdk";
const DEFAULT_STORE = "events";
const DB_VERSION = 1;

export interface IndexedDbQueueOptions {
  readonly factory: IDBFactory;
  readonly maxSize: number;
  readonly dbName?: string;
  readonly storeName?: string;
}

export class IndexedDbQueue implements EventQueue {
  public readonly layer: QueueLayer = "indexeddb";
  private readonly factory: IDBFactory;
  private readonly maxSize: number;
  private readonly dbName: string;
  private readonly storeName: string;
  private dbPromise: Promise<IDBDatabase> | null = null;

  public constructor(options: IndexedDbQueueOptions) {
    if (!Number.isInteger(options.maxSize) || options.maxSize <= 0) {
      throw new Error("IndexedDbQueue requires a positive integer maxSize");
    }
    this.factory = options.factory;
    this.maxSize = options.maxSize;
    this.dbName = options.dbName ?? DEFAULT_DB_NAME;
    this.storeName = options.storeName ?? DEFAULT_STORE;
  }

  public async enqueue(entry: QueueEntry): Promise<EnqueueOutcome> {
    const db = await this.openDb();
    const tx = db.transaction(this.storeName, "readwrite");
    const store = tx.objectStore(this.storeName);
    const allEntries = await readAllEntries(store);
    if (allEntries.length < this.maxSize) {
      await putRecord(store, entry);
      await waitForTransaction(tx);
      return { status: "accepted" };
    }
    const evictIdx = pickEvictionIndex(allEntries, entry);
    if (evictIdx === -1) {
      // Abort to avoid leaving the store in an inconsistent state.
      tx.abort();
      return { status: "rejected" };
    }
    const evicted = allEntries[evictIdx];
    if (evicted !== undefined) {
      await deleteRecord(store, evicted.payload.event_id);
    }
    await putRecord(store, entry);
    await waitForTransaction(tx);
    return {
      status: "accepted_with_drops",
      dropped: evicted === undefined ? [] : [evicted],
    };
  }

  public async size(): Promise<number> {
    const db = await this.openDb();
    const tx = db.transaction(this.storeName, "readonly");
    const store = tx.objectStore(this.storeName);
    const count = await asPromise<number>(store.count());
    await waitForTransaction(tx);
    return count;
  }

  public async drain(max: number): Promise<QueueEntry[]> {
    if (max <= 0) return [];
    const db = await this.openDb();
    const tx = db.transaction(this.storeName, "readwrite");
    const store = tx.objectStore(this.storeName);
    const drained = await drainCursor(store, max);
    await waitForTransaction(tx);
    return drained;
  }

  public async drainAll(): Promise<QueueEntry[]> {
    const db = await this.openDb();
    const tx = db.transaction(this.storeName, "readwrite");
    const store = tx.objectStore(this.storeName);
    const drained = await drainCursor(store, Number.POSITIVE_INFINITY);
    await waitForTransaction(tx);
    return drained;
  }

  public async requeue(entries: readonly QueueEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const db = await this.openDb();
    const tx = db.transaction(this.storeName, "readwrite");
    const store = tx.objectStore(this.storeName);
    for (const entry of entries) {
      await putRecord(store, entry);
    }
    // Enforce the size cap by trimming the oldest excess entries.
    const count = await asPromise<number>(store.count());
    if (count > this.maxSize) {
      const excess = count - this.maxSize;
      await trimOldest(store, excess);
    }
    await waitForTransaction(tx);
  }

  public async close(): Promise<void> {
    if (this.dbPromise === null) return;
    try {
      const db = await this.dbPromise;
      db.close();
    } finally {
      this.dbPromise = null;
    }
  }

  private openDb(): Promise<IDBDatabase> {
    if (this.dbPromise !== null) return this.dbPromise;
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = this.factory.open(this.dbName, DB_VERSION);
      req.onupgradeneeded = (): void => {
        const db = req.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          // Nested keyPath: IDBObjectStore reads `entry.payload.event_id`
          // as the primary key. The dotted notation is the standard
          // IndexedDB way to point at a nested property without wrapping
          // the keyPath in an array (which would produce a compound key
          // from multiple root-level paths instead).
          db.createObjectStore(this.storeName, { keyPath: "payload.event_id" });
        }
      };
      req.onsuccess = (): void => resolve(req.result);
      req.onerror = (): void => reject(req.error ?? new Error(`failed to open ${this.dbName}`));
      req.onblocked = (): void =>
        reject(new Error(`open of ${this.dbName} blocked by another connection`));
    });
    return this.dbPromise;
  }
}

/**
 * Probe whether IndexedDB is available and usable. Returns `false` for
 * private-browsing Safari (which throws on `open()`), for ad WebViews that
 * disable IndexedDB, and for any environment where the factory is missing.
 *
 * The probe deliberately attempts an `open()` so a Safari private-tab
 * environment that exposes `window.indexedDB` but rejects every operation
 * is correctly classified as unavailable.
 */
export async function probeIndexedDb(factory: IDBFactory | undefined): Promise<boolean> {
  if (factory === undefined) return false;
  const probeName = "__polaris_idb_probe__";
  return new Promise<boolean>((resolve) => {
    try {
      const req = factory.open(probeName, 1);
      req.onupgradeneeded = (): void => {
        const db = req.result;
        if (!db.objectStoreNames.contains("probe")) {
          db.createObjectStore("probe");
        }
      };
      req.onsuccess = (): void => {
        const db = req.result;
        db.close();
        try {
          const delReq = factory.deleteDatabase(probeName);
          delReq.onsuccess = (): void => resolve(true);
          delReq.onerror = (): void => resolve(true); // Probe still succeeded.
          delReq.onblocked = (): void => resolve(true);
        } catch {
          resolve(true);
        }
      };
      req.onerror = (): void => resolve(false);
      req.onblocked = (): void => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

// ---- Helpers ----------------------------------------------------------

function asPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void => reject(req.error ?? new Error("IDBRequest failed"));
  });
}

function waitForTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = (): void => resolve();
    tx.onerror = (): void => reject(tx.error ?? new Error("IDBTransaction failed"));
    tx.onabort = (): void => reject(tx.error ?? new Error("IDBTransaction aborted"));
  });
}

async function readAllEntries(store: IDBObjectStore): Promise<QueueEntry[]> {
  const all = await asPromise<unknown[]>(store.getAll());
  return all.filter(isQueueEntry);
}

function putRecord(store: IDBObjectStore, entry: QueueEntry): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const req = store.put(entry);
    req.onsuccess = (): void => resolve();
    req.onerror = (): void => reject(req.error ?? new Error("IDB put failed"));
  });
}

function deleteRecord(store: IDBObjectStore, eventId: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // keyPath is "payload.event_id" so the primary key is the event_id
    // string. No compound key wrapping needed.
    const req = store.delete(eventId);
    req.onsuccess = (): void => resolve();
    req.onerror = (): void => reject(req.error ?? new Error("IDB delete failed"));
  });
}

async function drainCursor(store: IDBObjectStore, max: number): Promise<QueueEntry[]> {
  return new Promise<QueueEntry[]>((resolve, reject) => {
    const out: QueueEntry[] = [];
    const req = store.openCursor();
    req.onsuccess = (): void => {
      const cursor = req.result;
      if (cursor === null || out.length >= max) {
        resolve(out);
        return;
      }
      const value = cursor.value as unknown;
      if (isQueueEntry(value)) {
        out.push(value);
      }
      cursor.delete();
      cursor.continue();
    };
    req.onerror = (): void => reject(req.error ?? new Error("IDB cursor failed"));
  });
}

async function trimOldest(store: IDBObjectStore, count: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let remaining = count;
    const req = store.openCursor();
    req.onsuccess = (): void => {
      const cursor = req.result;
      if (cursor === null || remaining <= 0) {
        resolve();
        return;
      }
      cursor.delete();
      remaining -= 1;
      cursor.continue();
    };
    req.onerror = (): void => reject(req.error ?? new Error("IDB trim failed"));
  });
}

function isQueueEntry(value: unknown): value is QueueEntry {
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
