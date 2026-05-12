/**
 * Priority overflow helpers shared between every queue layer.
 *
 * Per `docs/architecture/10-sdk-standards.md` § Queue Priority and Overflow:
 *
 *   When the queue is full, drop in this order:
 *     oldest low
 *     oldest normal
 *     oldest high
 *
 *   If all queued events are `high`, drop the oldest high-priority event
 *   only as a last resort.
 *
 * The doc also constrains:
 *
 *   - Priority affects local SDK retention only.
 *   - Priority does NOT change canonical event meaning.
 *   - Priority does NOT control vendor routing.
 *   - `track()` should NOT throw during normal queue overflow.
 *
 * The eviction strategy here is intentionally simple: every queue layer
 * holds entries in arrival order, and overflow scans them looking for the
 * first entry whose priority is lower than (or equal to) the incoming
 * entry's priority. That gives O(n) overflow cost — acceptable because
 * `maxQueueSize` is bounded at ~1000 events and overflow is the cold path.
 */

import type { EventPriority, QueueEntry } from "../types.js";

/** Lower number = drop-first under pressure. `low` < `normal` < `high`. */
const PRIORITY_RANK: Record<EventPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
};

export function rankOf(priority: EventPriority): number {
  return PRIORITY_RANK[priority];
}

/**
 * Pick the index of the entry to evict so the supplied `incoming` event
 * can land. Returns `-1` if the incoming entry should be rejected outright
 * (i.e. every queued entry is strictly higher priority than the incoming
 * one and the queue is full of higher-priority entries that we must not
 * displace).
 *
 * The doc's last-resort rule:
 *
 *   > If all queued events are `high`, drop the oldest high-priority
 *   > event only as a last resort.
 *
 * is interpreted as "when the incoming entry's priority is `high` and the
 * queue is also full of `high`, evict the oldest `high` to admit the new
 * one." A `low` event facing a queue of `high` events is rejected — that
 * is intentional retention of higher-value events under pressure.
 *
 * `entries` is the current queue ordered from oldest (index 0) to newest
 * (index n-1). The strategy:
 *
 *   1. Find the oldest entry with the lowest priority rank.
 *   2. If that rank is strictly lower than the incoming rank, evict it.
 *   3. If that rank is equal to the incoming rank, evict it (the doc's
 *      "drop oldest of this priority" wording).
 *   4. If every entry is strictly higher rank than the incoming entry,
 *      reject the incoming entry.
 */
export function pickEvictionIndex(entries: readonly QueueEntry[], incoming: QueueEntry): number {
  if (entries.length === 0) return -1;
  let lowestRank = Number.POSITIVE_INFINITY;
  let lowestIndex = -1;
  for (let i = 0; i < entries.length; i += 1) {
    const candidate = entries[i];
    if (candidate === undefined) continue;
    const r = rankOf(candidate.priority);
    if (r < lowestRank) {
      lowestRank = r;
      lowestIndex = i;
    }
  }
  if (lowestIndex === -1) return -1;
  const incomingRank = rankOf(incoming.priority);
  // We may evict an entry strictly lower than the incoming, OR equal to
  // the incoming (drop oldest of same priority). Strictly higher-priority
  // entries are never displaced by a lower-priority newcomer.
  if (lowestRank <= incomingRank) return lowestIndex;
  return -1;
}
