/**
 * A checkpoint store that cannot outrun the archive.
 *
 * Wraps any `CheckpointStore` and clamps every write to the highest
 * offset the archiver has actually put to object storage. The consumer is
 * untouched — it goes on checkpointing whenever it likes, and this
 * quietly holds the durable position back to what is true.
 *
 * ## Why the clamp lives here and not in the consumer
 *
 * Every other Polaris consumer's work is durable by the time its handler
 * returns: a ClickHouse insert, a PostgreSQL write, a published event.
 * The archiver is the only one that batches across messages, so it is the
 * only one for which "handler returned" and "work is durable" are
 * different moments. Teaching the consumer about deferred durability
 * would put a knob on every processor to serve one, and a knob that
 * defaults to the wrong answer is worse than no knob.
 *
 * ## What a clamped write means
 *
 * `write` never fails and never rejects a request as invalid. It writes
 * the smaller of what was asked and what is durable, and reports which
 * through the optional `onClamped` hook — a metric, not an error. Holding
 * a checkpoint back is normal operation for a batching consumer: it is
 * held back between every flush.
 *
 * When nothing on the stream is durable yet, the write is SKIPPED rather
 * than written as zero. A zero would rewind the consumer to the start of
 * the stream on the next restart, turning "we have not flushed yet" into
 * a full replay.
 */

import type { Checkpoint, CheckpointStore } from "@polaris/shared-transport";

export interface DeferredCheckpointStoreOptions {
  /** The real store. Reads pass straight through. */
  readonly inner: CheckpointStore;
  /**
   * Highest durably-archived offset for a stream, or `undefined` when
   * nothing on it has been put yet. Typically `batcher.durableOffset`.
   */
  readonly durableOffset: (stream: string) => string | undefined;
  /**
   * Called when a write was held back, with both offsets. Wire a metric
   * here: a clamp distance that grows without bound means flushes are
   * failing, and the checkpoint standing still is the only symptom until
   * the stream's retention window closes over the un-archived events.
   */
  readonly onClamped?: (input: {
    readonly stream: string;
    readonly requested: string;
    readonly written: string | null;
  }) => void;
}

export function createDeferredCheckpointStore(
  options: DeferredCheckpointStoreOptions,
): CheckpointStore {
  const { inner, durableOffset, onClamped } = options;

  return {
    read: (groupName, stream) => inner.read(groupName, stream),
    readAll: (groupName) => inner.readAll(groupName),
    async write(checkpoint: Checkpoint): Promise<void> {
      const durable = durableOffset(checkpoint.stream);
      if (durable === undefined) {
        // Nothing archived on this stream yet. Skipping leaves the
        // previous checkpoint in place; writing 0 would rewind to the
        // start of the stream on the next restart.
        onClamped?.({
          stream: checkpoint.stream,
          requested: checkpoint.last_offset,
          written: null,
        });
        return;
      }

      const requested = parseOffset(checkpoint.last_offset);
      const limit = parseOffset(durable);
      // An unparseable requested offset falls through to the clamp rather
      // than being compared as zero. Comparing it as zero would make it
      // look smaller than the durable offset and pass through UNCLAMPED,
      // which is the one outcome this module exists to prevent.
      if (requested !== null && limit !== null && requested <= limit) {
        await inner.write(checkpoint);
        return;
      }

      await inner.write({ ...checkpoint, last_offset: durable });
      onClamped?.({
        stream: checkpoint.stream,
        requested: checkpoint.last_offset,
        written: durable,
      });
    },
  };
}

function parseOffset(value: string): bigint | null {
  if (!/^\d+$/.test(value.trim())) return null;
  return BigInt(value.trim());
}
