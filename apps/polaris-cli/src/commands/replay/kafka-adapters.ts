/**
 * Replay execute adapters that wire the executor's source/producer
 * contracts to the real `@polaris/shared-transport` reader / producer.
 *
 * The CLI's `replay execute` command holds the no-op stubs that P7-003
 * shipped while `@polaris/shared-transport` did not yet expose an
 * offset-range reader. With Q0EGTY5V's reader in place, the source can
 * translate the executor's chunk (a time window) into per-partition
 * offset reads, and the producer can hand each republished record to
 * a `PolarisProducer`.
 *
 * The translation has three layers:
 *
 *   - **Time → offset.** For each `(chunk.from, chunk.to)`, callers
 *     supply a `fetchOffsetsForWindow(...)` lookup that resolves the
 *     per-partition `[startOffset, endOffset]` pair. Production wires
 *     this to KafkaJS's `admin.fetchTopicOffsetsByTimestamp` (chunk.to
 *     is offset-exclusive in the response so the caller subtracts 1);
 *     tests pass a synthetic table.
 *
 *   - **Offset → events.** Each partition's `[startOffset, endOffset]`
 *     pair is read via `readOffsetRange` against a driver. Production
 *     wraps a KafkaJS `Consumer` via `createKafkaJsConsumerDriver`;
 *     tests pass an in-memory driver.
 *
 *   - **Event → plan scope.** Plan-shaped filters (`event_name`,
 *     `event_id`, `project_id`, `environment`, and the chunk's
 *     `[from, to]` bounds) are applied in the adapter so the executor
 *     trusts what it receives. Any event whose `occurred_at` falls
 *     outside the chunk's inclusive bounds is dropped.
 *
 * @see packages/shared-transport/src/stream-range-reader.ts
 * @see packages/shared-replay/src/executor.ts
 * @see docs/architecture/05-processors-and-replay.md "Replay Control Plane"
 */

import {
  type OffsetRangeConsumerDriver,
  type OffsetRangeEvent,
  type PolarisProducer,
  readOffsetRange,
} from "@polaris/shared-transport";
import type {
  ReplayExecutorProducer,
  ReplayExecutorSource,
  ReplayProduceRecord,
  ReplaySourceEvent,
} from "@polaris/shared-replay";

/**
 * Per-partition offset bounds for a single chunk's time window. The
 * shape mirrors KafkaJS `SeekEntry` but uses string offsets throughout
 * to avoid Number-precision loss at high offsets.
 */
export interface KafkaReplayPartitionRange {
  readonly partition: number;
  readonly startOffset: string;
  readonly endOffset: string;
}

/**
 * Time → offset lookup the source adapter calls once per chunk. The
 * implementation queries KafkaJS in production; tests supply a static
 * table.
 *
 * Implementations must return a row per partition that participates in
 * the read; partitions with no events in the window may be omitted to
 * avoid spinning up a driver for nothing.
 */
export type FetchOffsetsForWindow = (input: {
  readonly topic: string;
  readonly from: number;
  readonly to: number;
}) => Promise<ReadonlyArray<KafkaReplayPartitionRange>>;

export interface BuildKafkaReplaySourceOptions {
  /** Concrete topic (post-isolation resolution). */
  readonly topic: string;
  /**
   * Driver factory called once per partition-read. Each driver instance
   * owns a single read-cycle: `readOffsetRange` invokes
   * `assign → seek → pullNextBatch* → release`. Production wraps a
   * fresh KafkaJS `Consumer` per call; tests pass a synthetic driver.
   */
  readonly driverFactory: () => OffsetRangeConsumerDriver;
  /** Per-chunk time → offset resolver. */
  readonly fetchOffsetsForWindow: FetchOffsetsForWindow;
}

/**
 * Build the source adapter. Stateless — the adapter holds no internal
 * state between chunks; each `fetchChunk` opens a driver per partition,
 * reads its slice, and lets the underlying driver release.
 */
export function buildKafkaReplaySource(
  options: BuildKafkaReplaySourceOptions,
): ReplayExecutorSource {
  return {
    async fetchChunk({ chunk, plan }) {
      const fromMs = Date.parse(chunk.from);
      const toMs = Date.parse(chunk.to);
      if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
        throw new Error(`replay chunk timestamp parse failed: from=${chunk.from} to=${chunk.to}`);
      }

      const partitionRanges = await options.fetchOffsetsForWindow({
        topic: options.topic,
        from: fromMs,
        to: toMs,
      });

      const events: ReplaySourceEvent[] = [];
      for (const range of partitionRanges) {
        if (BigInt(range.startOffset) > BigInt(range.endOffset)) continue;
        const driver = options.driverFactory();
        const result = await readOffsetRange(driver, {
          topic: options.topic,
          partition: range.partition,
          startOffset: range.startOffset,
          endOffset: range.endOffset,
        });
        for (const raw of result.events) {
          const projected = toReplaySourceEvent(raw);
          if (!matchesPlanScope(projected, plan)) continue;
          if (!withinChunkBounds(projected, chunk)) continue;
          events.push(projected);
        }
      }
      return events;
    },
  };
}

export interface BuildKafkaReplayProducerOptions {
  /**
   * A `PolarisProducer` that the caller has already (or will) connect.
   * The adapter does NOT manage the producer's lifecycle — the runner
   * is responsible for `connect()` / `disconnect()`.
   */
  readonly producer: PolarisProducer;
}

/**
 * Build the producer adapter. Each `publish` becomes a single-message
 * `PolarisProducer.send` call. The producer's `send` shape accepts a
 * pre-built record with topic, key, value, and headers, which mirrors
 * the executor's {@link ReplayProduceRecord} 1:1.
 */
export function buildKafkaReplayProducer(
  options: BuildKafkaReplayProducerOptions,
): ReplayExecutorProducer {
  return {
    async publish(record: ReplayProduceRecord): Promise<void> {
      await options.producer.send({
        topic: record.topic,
        messages: [
          {
            key: record.partition_key,
            value: Buffer.from(record.value),
            headers: record.headers,
          },
        ],
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toReplaySourceEvent(raw: OffsetRangeEvent): ReplaySourceEvent {
  return {
    event_id: raw.event_id,
    event_name: raw.event_name,
    project_id: raw.project_id,
    environment: raw.environment,
    occurred_at: raw.occurred_at,
    partition_key: raw.partition_key,
    value: raw.value,
    headers: raw.headers,
  };
}

function matchesPlanScope(
  event: ReplaySourceEvent,
  plan: {
    readonly project_id: string;
    readonly environment: string;
    readonly event_name: string | null;
    readonly event_id: string | null;
  },
): boolean {
  if (event.project_id !== plan.project_id) return false;
  if (event.environment !== plan.environment) return false;
  if (plan.event_name !== null && event.event_name !== plan.event_name) return false;
  if (plan.event_id !== null && event.event_id !== plan.event_id) return false;
  return true;
}

function withinChunkBounds(
  event: ReplaySourceEvent,
  chunk: { readonly from: string; readonly to: string },
): boolean {
  // `occurred_at` is ISO 8601 UTC; lexical comparison is order-preserving.
  return event.occurred_at >= chunk.from && event.occurred_at <= chunk.to;
}
