/**
 * `LayeredEventQueue` — orchestrates capability detection and routes every
 * operation through the strongest available queue layer.
 *
 * Per `docs/architecture/10-sdk-standards.md` § Web SDK Queue Model:
 *
 *   IndexedDB preferred
 *   localStorage fallback
 *   memory fallback
 *
 * Capability detection runs at construction:
 *
 *   1. If an `IndexedDbQueue` succeeds opening a probe database, the
 *      SDK lands on the IndexedDB layer.
 *   2. Otherwise, if a writable `localStorage` is exposed, the SDK lands
 *      on the LocalStorageQueue.
 *   3. The MemoryQueue is the always-available last resort.
 *
 * `LayeredEventQueue` does NOT mirror writes across layers. Mirroring an
 * event queue would lead to duplicate delivery (a tab that flushes from
 * IndexedDB would not know about the localStorage mirror). The identity
 * layer mirrors because identity is a single-value cache; the queue is a
 * stream and must have exactly one canonical home.
 *
 * Construction is async because IndexedDB probing is asynchronous. Use
 * `LayeredEventQueue.create(opts)` rather than `new LayeredEventQueue()`.
 */

import type { EnqueueOutcome, EventQueue, QueueEntry, QueueLayer } from "../types.js";
import { IndexedDbQueue, probeIndexedDb } from "./indexeddb-queue.js";
import { LocalStorageQueue } from "./localstorage-queue.js";
import { MemoryQueue } from "./memory-queue.js";

export interface LayeredEventQueueOptions {
  readonly maxSize: number;
  readonly indexedDB?: IDBFactory | undefined;
  readonly localStorage?: Storage | undefined;
  /**
   * Override the layer order considered at startup. The first layer that
   * is available wins. Defaults to the doctrinal order:
   * `["indexeddb", "localstorage", "memory"]`.
   */
  readonly layerOrder?: readonly QueueLayer[];
}

const DEFAULT_ORDER: readonly QueueLayer[] = ["indexeddb", "localstorage", "memory"];

export class LayeredEventQueue implements EventQueue {
  public readonly layer: QueueLayer;
  private readonly inner: EventQueue;

  private constructor(inner: EventQueue) {
    this.inner = inner;
    this.layer = inner.layer;
  }

  /**
   * Construct a queue layered onto the strongest available browser store.
   * Asynchronous because IndexedDB probing is asynchronous; the SDK
   * constructor awaits this before exposing `track()`.
   */
  public static async create(options: LayeredEventQueueOptions): Promise<LayeredEventQueue> {
    const order = options.layerOrder ?? DEFAULT_ORDER;
    for (const layer of order) {
      if (layer === "indexeddb") {
        if (options.indexedDB === undefined) continue;
        const ok = await probeIndexedDb(options.indexedDB);
        if (ok) {
          return new LayeredEventQueue(
            new IndexedDbQueue({ factory: options.indexedDB, maxSize: options.maxSize }),
          );
        }
        continue;
      }
      if (layer === "localstorage") {
        if (options.localStorage === undefined) continue;
        if (!isLocalStorageWritable(options.localStorage)) continue;
        return new LayeredEventQueue(
          new LocalStorageQueue({ storage: options.localStorage, maxSize: options.maxSize }),
        );
      }
      if (layer === "memory") {
        return new LayeredEventQueue(new MemoryQueue({ maxSize: options.maxSize }));
      }
    }
    // Defensive — the memory queue is always constructible, so we should
    // never reach here with the default order, but a custom layerOrder
    // might omit memory. Falling forward to memory keeps the SDK alive.
    return new LayeredEventQueue(new MemoryQueue({ maxSize: options.maxSize }));
  }

  public enqueue(entry: QueueEntry): Promise<EnqueueOutcome> {
    return this.inner.enqueue(entry);
  }

  public size(): Promise<number> {
    return this.inner.size();
  }

  public drain(max: number): Promise<QueueEntry[]> {
    return this.inner.drain(max);
  }

  public drainAll(): Promise<QueueEntry[]> {
    return this.inner.drainAll();
  }

  public requeue(entries: readonly QueueEntry[]): Promise<void> {
    return this.inner.requeue(entries);
  }

  public async close(): Promise<void> {
    if (this.inner.close !== undefined) {
      await this.inner.close();
    }
  }
}

const PROBE_KEY = "__polaris_queue_probe__";

function isLocalStorageWritable(storage: Storage): boolean {
  try {
    storage.setItem(PROBE_KEY, "1");
    const got = storage.getItem(PROBE_KEY);
    storage.removeItem(PROBE_KEY);
    return got === "1";
  } catch {
    return false;
  }
}
