/**
 * Bounded in-memory event queue.
 *
 * The last-resort queue layer per `docs/architecture/10-sdk-standards.md`:
 *
 *   IndexedDB preferred
 *   localStorage fallback
 *   memory fallback
 *
 * Memory queue events are LOST on page reload — the docs are explicit
 * that page-exit delivery is best-effort, and the SDK lands here only
 * when IndexedDB and localStorage are both unavailable (rare even on
 * locked-down ad WebViews, but possible in private-browsing iframes).
 *
 * Overflow drops by priority (oldest low first, then oldest normal, then
 * oldest high) per `pickEvictionIndex`. `track()` does not throw on
 * overflow — the SDK surfaces the drop via `onDrop`.
 */

import type { EnqueueOutcome, EventQueue, QueueEntry, QueueLayer } from "../types.js";
import { pickEvictionIndex } from "./priority.js";

export interface MemoryQueueOptions {
  readonly maxSize: number;
}

export class MemoryQueue implements EventQueue {
  public readonly layer: QueueLayer = "memory";
  private readonly maxSize: number;
  private readonly buffer: QueueEntry[] = [];

  public constructor(options: MemoryQueueOptions) {
    if (!Number.isInteger(options.maxSize) || options.maxSize <= 0) {
      throw new Error("MemoryQueue requires a positive integer maxSize");
    }
    this.maxSize = options.maxSize;
  }

  public enqueue(entry: QueueEntry): Promise<EnqueueOutcome> {
    if (this.buffer.length < this.maxSize) {
      this.buffer.push(entry);
      return Promise.resolve({ status: "accepted" });
    }
    const evictIdx = pickEvictionIndex(this.buffer, entry);
    if (evictIdx === -1) {
      return Promise.resolve({ status: "rejected" });
    }
    const [evicted] = this.buffer.splice(evictIdx, 1);
    this.buffer.push(entry);
    return Promise.resolve({
      status: "accepted_with_drops",
      dropped: evicted === undefined ? [] : [evicted],
    });
  }

  public size(): Promise<number> {
    return Promise.resolve(this.buffer.length);
  }

  public drain(max: number): Promise<QueueEntry[]> {
    if (max <= 0 || this.buffer.length === 0) return Promise.resolve([]);
    const slice = this.buffer.splice(0, Math.min(max, this.buffer.length));
    return Promise.resolve(slice);
  }

  public drainAll(): Promise<QueueEntry[]> {
    const slice = this.buffer.splice(0, this.buffer.length);
    return Promise.resolve(slice);
  }

  /**
   * Push events back to the head of the queue. Used after a transient
   * transport failure so `event_id` is preserved across retries.
   *
   * If returning the entries would exceed `maxSize`, the surplus is dropped
   * at the tail. Producers care about preserving in-flight events (they
   * may already have known event_ids and partial retries); newer queued
   * events lose under pressure. The drop is observable: the SDK calls
   * `size()` before and after to surface diagnostics.
   */
  public requeue(entries: readonly QueueEntry[]): Promise<void> {
    if (entries.length === 0) return Promise.resolve();
    this.buffer.unshift(...entries);
    if (this.buffer.length > this.maxSize) {
      this.buffer.length = this.maxSize;
    }
    return Promise.resolve();
  }
}
