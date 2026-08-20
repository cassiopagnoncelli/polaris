/**
 * Bounded in-memory queue adapter.
 *
 * Per `docs/architecture/10-sdk-standards.md`:
 *
 *   - Default Node SDK queue is bounded in-memory.
 *   - Node SDK supports batching, retry, interval flush, batch-size flush,
 *     and manual `flush()`.
 *   - Preserve `event_id` across retries.
 *   - Do not pretend the default Node SDK queue survives process crashes.
 *
 * The adapter implements the `QueueAdapter` contract from `../types.ts`.
 * Overflow behaviour rejects new events when the queue is full (returns
 * `false` from `enqueue`); the SDK core surfaces this as an `onDrop`
 * callback with reason `queue_overflow` and a corresponding
 * `onDiagnostic` event. We do NOT evict older events from the head — that
 * would silently lose events the producer has not yet seen ack'd. Future
 * durable adapters may implement different policies.
 */

import type { QueueAdapter, QueuedEvent } from "../types.js";

export interface MemoryQueueOptions {
  readonly maxSize: number;
}

export class MemoryQueueAdapter implements QueueAdapter {
  private readonly maxSize: number;
  private readonly buffer: QueuedEvent[] = [];

  public constructor(options: MemoryQueueOptions) {
    if (!Number.isInteger(options.maxSize) || options.maxSize <= 0) {
      throw new Error("MemoryQueueAdapter requires a positive integer maxSize");
    }
    this.maxSize = options.maxSize;
  }

  public enqueue(event: QueuedEvent): boolean {
    if (this.buffer.length >= this.maxSize) return false;
    this.buffer.push(event);
    return true;
  }

  public size(): number {
    return this.buffer.length;
  }

  public drain(max: number): QueuedEvent[] {
    if (max <= 0 || this.buffer.length === 0) return [];
    return this.buffer.splice(0, Math.min(max, this.buffer.length));
  }

  /**
   * Push events back to the head of the queue, preserving original order.
   * Used by the SDK core after a transient transport failure so
   * `event_id` is preserved across retries.
   *
   * If returning the events would exceed `maxSize`, the surplus is
   * dropped at the tail rather than at the head. Producers care about
   * preserving the events already in-flight (they may be retried already
   * and have known event_ids); newer queued events lose under pressure.
   * The drop is observable: the SDK can call `size()` before and after
   * to surface diagnostics.
   */
  public requeue(events: readonly QueuedEvent[]): void {
    if (events.length === 0) return;
    const room = this.maxSize - this.buffer.length;
    if (events.length <= room) {
      this.buffer.unshift(...events);
      return;
    }
    // Keep returning events; drop the tail of the existing queue if we
    // have to (rare under typical retry pressure but well-defined).
    this.buffer.unshift(...events);
    if (this.buffer.length > this.maxSize) {
      this.buffer.length = this.maxSize;
    }
  }
}
