/**
 * Replay execute adapters that wire the executor's source/producer
 * contracts to the real `@polaris/bus` reader / producer.
 *
 * ## What the RabbitMQ move deleted
 *
 * Under Kafka this file had three layers: time → offset (an admin call
 * per chunk per partition, plus off-by-one handling because
 * `fetchTopicOffsetsByTimestamp` is offset-exclusive), offset → events,
 * and event → plan scope. RabbitMQ streams accept a timestamp as the
 * attach point, so the first layer is gone entirely — and with it the
 * `FetchOffsetsForWindow` seam, the admin client, and the empty-range
 * bookkeeping.
 *
 * What remains:
 *
 *   - **Window → events.** Each partition stream is read via
 *     `readStreamRange`, which attaches at the chunk's start timestamp
 *     and stops at the first message past its end (plus slack for
 *     late-arriving events: stream order is ingestion order, but the
 *     plan's window is evaluated against `occurred_at`).
 *
 *   - **Event → plan scope.** Plan-shaped filters (`event_name`,
 *     `event_id`, `project_id`, `environment`, and the chunk's
 *     `[from, to]` bounds) are applied here so the executor trusts what
 *     it receives. Any event whose `occurred_at` falls outside the
 *     chunk's inclusive bounds is dropped — which is also what makes the
 *     reader's chunk-granular attach harmless.
 *
 * @see libs/bus/src/partition-stream-readers.ts
 * @see libs/archive/replay/src/executor.ts
 * @see docs/architecture/05-processors-and-replay.md "Replay Control Plane"
 */

import type {
  ReplayExecutorProducer,
  ReplayExecutorSource,
  ReplayProduceRecord,
  ReplaySourceEvent,
} from "@polaris/archive-replay";
import {
  type PolarisProducer,
  partitionStreamNames,
  readStreamRange,
  type StreamRangeDriver,
  type StreamRangeEvent,
} from "@polaris/bus";

export interface BuildStreamReplaySourceOptions {
  /** Concrete super-stream family (post-isolation resolution). */
  readonly family: string;
  /** Super-stream width. Every partition is read; replay joins no group. */
  readonly partitions: number;
  /**
   * Driver factory called once per partition read. Each driver instance
   * owns a single read cycle: `readStreamRange` invokes `start` then
   * `release`. Production opens a fresh channel per call; tests pass a
   * synthetic driver.
   */
  readonly driverFactory: () => StreamRangeDriver;
  /**
   * Idle timeout handed to the reader — how long silence means "tail
   * reached". Optional; the reader's default is 5s.
   */
  readonly idleTimeoutMs?: number;
}

/**
 * Build the source adapter. Stateless — the adapter holds no state
 * between chunks; each `fetchChunk` opens a driver per partition, reads
 * its slice, and releases it.
 */
export function buildStreamReplaySource(
  options: BuildStreamReplaySourceOptions,
): ReplayExecutorSource {
  return {
    async fetchChunk({ chunk, plan }) {
      const fromMs = Date.parse(chunk.from);
      const toMs = Date.parse(chunk.to);
      if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
        throw new Error(`replay chunk timestamp parse failed: from=${chunk.from} to=${chunk.to}`);
      }

      const events: ReplaySourceEvent[] = [];
      for (const stream of partitionStreamNames(options.family, options.partitions)) {
        const driver = options.driverFactory();
        const result = await readStreamRange(driver, {
          stream,
          fromTimestampMs: fromMs,
          toTimestampMs: toMs,
          ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
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

export interface BuildStreamReplayProducerOptions {
  /**
   * A `PolarisProducer` that the caller has already (or will) connect.
   * The adapter does NOT manage the producer's lifecycle — the runner
   * is responsible for `connect()` / `disconnect()`.
   */
  readonly producer: PolarisProducer;
}

/**
 * Build the producer adapter. Each `publish` becomes a single confirmed
 * publish into the target super stream; the record's `partition_key`
 * carries through from the source, so a replayed event lands on the same
 * partition as the original and per-identity ordering survives the round
 * trip.
 */
export function buildStreamReplayProducer(
  options: BuildStreamReplayProducerOptions,
): ReplayExecutorProducer {
  return {
    async publish(record: ReplayProduceRecord): Promise<void> {
      await options.producer.publish({
        family: record.topic,
        value: Buffer.from(record.value),
        partitionKey: record.partition_key,
        headers: record.headers,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toReplaySourceEvent(raw: StreamRangeEvent): ReplaySourceEvent {
  return {
    event_id: raw.event_id,
    event_name: raw.event_name,
    project_id: raw.project_id,
    environment: raw.environment,
    occurred_at: raw.occurred_at,
    // A message published without a key would otherwise republish onto
    // partition 0 and break ordering for everything already there; the
    // event id is the same fallback the canonical partition-key builder
    // uses.
    partition_key: raw.partition_key ?? raw.event_id,
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
