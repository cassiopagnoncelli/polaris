/**
 * Offset-range reader.
 *
 * Polaris replay turns a deterministic plan into a sequence of Kafka reads
 * + republished events. The plan owns the time window; the
 * `@polaris/shared-replay` executor walks the chunks; the **reader** in
 * this module is the only place that actually talks to a Redpanda
 * partition.
 *
 * The reader takes a single partition's offset range
 * `[startOffset, endOffset]` (inclusive on both ends, mirroring the rest
 * of the replay control plane's window semantics) and returns the events
 * within that range projected through Polaris's standard header
 * conventions. The shape it returns is intentionally structurally
 * compatible with `@polaris/shared-replay`'s `ReplaySourceEvent` so a
 * downstream replay-source adapter can pass the reader's output through
 * without an extra normalisation pass.
 *
 * Architectural rules baked into this module:
 *
 *   - **No assignment, no groups.** The reader uses a non-group consumer
 *     style: `seek` to `startOffset`, read messages, stop when the
 *     partition reaches `endOffset` or the high-water mark. This keeps
 *     replay reads from disturbing live consumer-group offsets and lets
 *     the CLI run multiple replay-readers in parallel without group
 *     coordination.
 *
 *   - **Range bounded by both offsets and the partition's high-water
 *     mark.** A replay window can be requested up to "now"; the reader
 *     clamps `endOffset` to the partition's high-water mark at read time
 *     so a replay never blocks waiting for new traffic.
 *
 *   - **Partition reassignment is tolerated.** A rebalance event in the
 *     middle of a read returns the events emitted so far rather than
 *     throwing; the executor's chunk loop reads them as a partial result
 *     and the next chunk picks up where this one left off. The reader
 *     records the last successfully read offset on the result so the
 *     caller can resume.
 *
 *   - **Headers project through.** The reader extracts the standard
 *     Polaris platform headers (`polaris-event-id`,
 *     `polaris-event-name`, `polaris-project-id`, `polaris-environment`,
 *     `polaris-occurred-at`) onto the typed fields the replay executor
 *     consumes; remaining headers are stringified into a
 *     `Record<string, string>` so the executor can serialise them back
 *     into kafkajs's `IHeaders` shape when republishing.
 *
 *   - **No KafkaJS escape leaks.** Callers do not see KafkaJS types in
 *     the reader's input/output. The reader takes a small
 *     `OffsetRangeConsumerDriver` capability that real callers wire via
 *     `createKafkaJsConsumerDriver(consumer)`; tests pass an in-memory
 *     fake. This is the same pattern the rest of the package follows
 *     (compare the `KafkaHooks` seam in `./hooks`).
 *
 * @see docs/architecture/05-processors-and-replay.md "Replay Control Plane"
 * @see docs/architecture/03-redpanda-topics.md "Default Canonical Topics"
 * @see packages/shared-replay/src/executor.ts (downstream consumer)
 */

import type { Consumer, EachBatchPayload, KafkaMessage } from "kafkajs";
import {
  POLARIS_HEADER_ENVIRONMENT,
  POLARIS_HEADER_EVENT_ID,
  POLARIS_HEADER_EVENT_NAME,
  POLARIS_HEADER_OCCURRED_AT,
  POLARIS_HEADER_PROJECT_ID,
  readHeaderString,
} from "./headers.js";

// ---------------------------------------------------------------------------
// Public input / output shapes
// ---------------------------------------------------------------------------

/**
 * A single event read from a source partition. The shape is
 * intentionally structurally compatible with
 * `@polaris/shared-replay`'s `ReplaySourceEvent` so a thin replay-source
 * adapter can hand the reader's output to the executor without a
 * field-by-field copy.
 *
 * `value` is `Uint8Array` (not `Buffer`) so non-Node consumers — and the
 * executor's pure module which does not depend on Node typings — can
 * forward the bytes through without an explicit cast.
 */
export interface OffsetRangeEvent {
  /** Source topic the event was read from. */
  readonly topic: string;
  /** Source partition the event was read from. */
  readonly partition: number;
  /** Offset the event sits at. Echoed for lineage / debug logging. */
  readonly offset: string;
  /** Platform-issued event id (UUIDv7) from `polaris-event-id`. */
  readonly event_id: string;
  /** Canonical event name (e.g. `purchase`) from `polaris-event-name`. */
  readonly event_name: string;
  /** Project id from `polaris-project-id`. */
  readonly project_id: string;
  /** Environment from `polaris-environment`. */
  readonly environment: string;
  /** Inclusive timestamp the event was emitted (`polaris-occurred-at`). */
  readonly occurred_at: string;
  /** Partition key the original producer used — the kafkajs message key. */
  readonly partition_key: string;
  /** Raw envelope bytes — the kafkajs message value. */
  readonly value: Uint8Array;
  /** Original headers stringified to a plain `Record<string, string>`. */
  readonly headers: Record<string, string>;
}

/**
 * Input accepted by {@link readOffsetRange}. Mirrors the AC signature
 * `(topic, partition, startOffset, endOffset)`; the function form takes
 * an object so additional knobs (per-partition timeout, batch hint) can
 * be added without a breaking change.
 *
 * Offsets are stringified longs to mirror KafkaJS's wire shape. The
 * reader accepts plain numbers as a convenience for tests.
 */
export interface ReadOffsetRangeInput {
  /** Concrete Redpanda topic name. */
  readonly topic: string;
  /** Partition number (`>= 0`). */
  readonly partition: number;
  /** Inclusive start offset. */
  readonly startOffset: string | number | bigint;
  /** Inclusive end offset. */
  readonly endOffset: string | number | bigint;
  /**
   * Per-read deadline. When the consumer driver has not delivered a
   * batch within this many ms after the last delivered batch (or after
   * the initial seek), the reader returns whatever has been collected so
   * far with `terminationReason: 'idle_timeout'`. Defaults to 30_000.
   */
  readonly idleTimeoutMs?: number;
}

/**
 * Outcome of {@link readOffsetRange}. Carries the events plus a closed
 * set of termination reasons so callers can branch on whether the read
 * exhausted the range, hit the partition's high-water mark before
 * `endOffset`, was cut short by a rebalance, or timed out idle.
 */
export interface ReadOffsetRangeResult {
  /** Events collected in offset order. */
  readonly events: ReadonlyArray<OffsetRangeEvent>;
  /** Last offset successfully read, or `null` when none were read. */
  readonly lastOffset: string | null;
  /**
   * Why the reader stopped:
   *
   *   - `range_exhausted` — read up to and including `endOffset`.
   *   - `partition_end`   — partition's high-water mark was hit before
   *                         `endOffset` was reached.
   *   - `rebalance`       — partition reassignment was reported mid-read;
   *                         caller may resume from `lastOffset + 1` after
   *                         a new range is computed.
   *   - `idle_timeout`    — no new batches arrived within the idle window;
   *                         caller should treat this as a soft failure.
   *   - `empty_range`     — `startOffset > endOffset`, no I/O performed.
   */
  readonly terminationReason: OffsetRangeTerminationReason;
}

export const OFFSET_RANGE_TERMINATION_REASONS = [
  "range_exhausted",
  "partition_end",
  "rebalance",
  "idle_timeout",
  "empty_range",
] as const;
export type OffsetRangeTerminationReason = (typeof OFFSET_RANGE_TERMINATION_REASONS)[number];

// ---------------------------------------------------------------------------
// Driver seam (so tests don't need a real broker)
// ---------------------------------------------------------------------------

/**
 * A batch the consumer driver hands the reader. Mirrors a flattened
 * subset of kafkajs's `EachBatchPayload.batch` plus the partition meta
 * the reader needs to bound its read.
 *
 * Implementations either:
 *
 *   - in production: wrap a kafkajs `Consumer` via
 *     {@link createKafkaJsConsumerDriver}; the wrapper handles the
 *     `eachBatch` / `seek` / `disconnect` lifecycle,
 *   - in tests: synthesise a sequence of batches without touching a
 *     broker.
 */
export interface OffsetRangeBatch {
  /** Topic this batch was fetched from. */
  readonly topic: string;
  /** Partition this batch was fetched from. */
  readonly partition: number;
  /** Partition's high-water mark at fetch time (stringified long). */
  readonly highWatermark: string;
  /** Messages in offset order. */
  readonly messages: ReadonlyArray<OffsetRangeBatchMessage>;
}

/**
 * A single message delivered inside an {@link OffsetRangeBatch}.
 * Structurally compatible with kafkajs's `KafkaMessage`.
 */
export interface OffsetRangeBatchMessage {
  readonly offset: string;
  readonly key: Buffer | string | null;
  readonly value: Buffer | null;
  readonly headers?: Record<string, Buffer | string | (string | Buffer)[] | undefined>;
  readonly timestamp?: string;
}

/**
 * Capability the reader uses to drive a Kafka consumer. The driver is
 * intentionally small: the reader controls termination through the
 * driver, not through KafkaJS callbacks. The reader does the offset
 * accounting itself.
 *
 * Lifecycle:
 *
 *   1. caller hands the driver to `readOffsetRange`,
 *   2. the reader calls `assign(topic, partition)` to set up the read,
 *   3. the reader calls `seek(offset)` to position at `startOffset`,
 *   4. the reader calls `pullNextBatch(signal)` in a loop; the driver
 *      returns the next batch (or `null` for end-of-range / timeout),
 *   5. the reader calls `release()` when finished; the driver tears down
 *      whatever state it owns (the kafkajs consumer's `stop()` /
 *      `disconnect()` is the typical implementation).
 */
export interface OffsetRangeConsumerDriver {
  /** Subscribe + assign a single partition. Idempotent per driver. */
  assign(topic: string, partition: number): Promise<void>;
  /** Seek the assignment to a specific offset. */
  seek(topic: string, partition: number, offset: string): Promise<void>;
  /**
   * Pull the next batch (or `null` if the partition is exhausted /
   * stopped). Honours the supplied abort signal — when aborted, the
   * driver returns the partial state it has and the reader treats it as
   * an idle timeout.
   *
   * A driver may return an empty `messages` array to signal liveness
   * (heartbeat tick); the reader treats it as a no-op and pulls again.
   */
  pullNextBatch(signal: AbortSignal): Promise<OffsetRangeBatch | null>;
  /** Tear down driver-owned resources. Idempotent. */
  release(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Reader entry point
// ---------------------------------------------------------------------------

/**
 * Read events from a partition's `[startOffset, endOffset]` (inclusive).
 *
 * Behavior:
 *
 *   - `startOffset > endOffset` returns immediately with
 *     `terminationReason: 'empty_range'`.
 *   - A batch whose first message is past `endOffset` terminates the
 *     read with `range_exhausted`.
 *   - A batch whose high-water mark is `<= endOffset + 1` and whose last
 *     message is the partition's end terminates with `partition_end`.
 *   - A `null` return from the driver while events are still expected
 *     terminates with `idle_timeout`.
 *   - Returned events are filtered to `[startOffset, endOffset]` — a
 *     batch that overlaps the boundaries on either side has the
 *     out-of-range messages dropped.
 *
 * The reader never throws on a missing message field: a kafkajs message
 * with `value === null` is treated as a tombstone and skipped; a message
 * with no `polaris-event-id` header is dropped from the result (replay
 * cannot identify it). Both cases are silent — callers that need
 * counting can wrap the reader.
 */
export async function readOffsetRange(
  driver: OffsetRangeConsumerDriver,
  input: ReadOffsetRangeInput,
): Promise<ReadOffsetRangeResult> {
  const startOffset = toBigInt(input.startOffset);
  const endOffset = toBigInt(input.endOffset);

  if (startOffset > endOffset) {
    return {
      events: [],
      lastOffset: null,
      terminationReason: "empty_range",
    };
  }

  const idleTimeoutMs = input.idleTimeoutMs ?? 30_000;
  const events: OffsetRangeEvent[] = [];
  let lastOffset: string | null = null;
  let termination: OffsetRangeTerminationReason | null = null;

  try {
    await driver.assign(input.topic, input.partition);
    await driver.seek(input.topic, input.partition, startOffset.toString());

    while (termination === null) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), idleTimeoutMs);
      let batch: OffsetRangeBatch | null;
      try {
        batch = await driver.pullNextBatch(controller.signal);
      } finally {
        clearTimeout(timeout);
      }

      if (batch === null) {
        // Driver decided the partition is done. If we've already read
        // everything inside the range, count it as range_exhausted;
        // otherwise treat as an idle timeout so the caller retries.
        if (controller.signal.aborted) {
          termination = "idle_timeout";
        } else if (lastOffset !== null && toBigInt(lastOffset) >= endOffset) {
          termination = "range_exhausted";
        } else {
          termination = "partition_end";
        }
        break;
      }

      if (batch.topic !== input.topic || batch.partition !== input.partition) {
        // The driver delivered a batch from another assignment — treat
        // as a rebalance signal and return what we have so far.
        termination = "rebalance";
        break;
      }

      // Empty batches act as liveness ticks. If the partition's
      // high-water mark is at or below `endOffset + 1` and we've already
      // covered everything that exists, exit.
      if (batch.messages.length === 0) {
        const highWatermark = toBigInt(batch.highWatermark);
        const nextExpected = lastOffset === null ? startOffset : toBigInt(lastOffset) + 1n;
        if (highWatermark <= nextExpected) {
          termination = highWatermark > endOffset ? "range_exhausted" : "partition_end";
          break;
        }
        continue;
      }

      for (const message of batch.messages) {
        const offset = toBigInt(message.offset);
        if (offset < startOffset) continue;
        if (offset > endOffset) {
          termination = "range_exhausted";
          break;
        }
        const event = projectMessage(input.topic, input.partition, message);
        if (event !== null) {
          events.push(event);
        }
        lastOffset = message.offset;
      }

      if (termination !== null) break;

      // Termination by partition's end-of-stream — last delivered offset
      // is one less than the high-water mark.
      const highWatermark = toBigInt(batch.highWatermark);
      if (lastOffset !== null && toBigInt(lastOffset) + 1n >= highWatermark) {
        termination = toBigInt(lastOffset) >= endOffset ? "range_exhausted" : "partition_end";
        break;
      }
      if (lastOffset !== null && toBigInt(lastOffset) >= endOffset) {
        termination = "range_exhausted";
        break;
      }
    }
  } finally {
    await driver.release();
  }

  return {
    events,
    lastOffset,
    terminationReason: termination ?? "partition_end",
  };
}

// ---------------------------------------------------------------------------
// KafkaJS driver
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link createKafkaJsConsumerDriver}.
 */
export interface CreateKafkaJsConsumerDriverOptions {
  /**
   * A connected (or about-to-be-connected) KafkaJS `Consumer`. The
   * driver assumes ownership of the consumer's `run` loop — callers
   * should not wire `eachMessage` / `eachBatch` themselves before
   * handing it to the driver.
   */
  readonly consumer: Consumer;
  /**
   * When `true` (default), the driver calls `consumer.disconnect()` in
   * `release()`. Set to `false` to reuse the consumer for subsequent
   * partitions.
   */
  readonly disconnectOnRelease?: boolean;
}

/**
 * Build an {@link OffsetRangeConsumerDriver} backed by a KafkaJS
 * `Consumer`. Production replays wire this driver around a consumer
 * dedicated to the replay-job (the consumer group naming convention is
 * owned by `@polaris/shared-replay`'s planner).
 *
 * The driver:
 *
 *   - subscribes to the assigned topic (one partition at a time),
 *   - starts `consumer.run({ eachBatch })` once and bridges batches
 *     into the reader's `pullNextBatch` async queue,
 *   - signals end-of-stream when the consumer reports it has caught up
 *     with the high-water mark.
 */
export function createKafkaJsConsumerDriver(
  options: CreateKafkaJsConsumerDriverOptions,
): OffsetRangeConsumerDriver {
  const { consumer, disconnectOnRelease = true } = options;

  let running = false;
  let released = false;
  const queue: Array<OffsetRangeBatch | null> = [];
  const waiters: Array<{
    resolve: (batch: OffsetRangeBatch | null) => void;
    reject: (err: unknown) => void;
    signal: AbortSignal;
    listener: () => void;
  }> = [];

  function enqueue(value: OffsetRangeBatch | null): void {
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.listener);
      waiter.resolve(value);
      return;
    }
    queue.push(value);
  }

  async function startRunLoopIfNeeded(): Promise<void> {
    if (running) return;
    running = true;
    await consumer.run({
      eachBatchAutoResolve: false,
      eachBatch: async (payload: EachBatchPayload) => {
        const batch = toBatch(payload);
        enqueue(batch);
        // Resolve the kafkajs commit boundary so the consumer keeps
        // moving forward even when the reader is slow to drain.
        for (const message of payload.batch.messages) {
          payload.resolveOffset(message.offset);
        }
        await payload.heartbeat();
      },
    });
  }

  return {
    async assign(topic, _partition) {
      await consumer.subscribe({ topics: [topic], fromBeginning: true });
      await startRunLoopIfNeeded();
    },
    async seek(topic, partition, offset) {
      // KafkaJS requires the consumer to be `run()`-started before
      // `seek` takes effect. Calls to `assign` already started the loop.
      consumer.seek({ topic, partition, offset });
    },
    async pullNextBatch(signal) {
      if (released) return null;
      const buffered = queue.shift();
      if (buffered !== undefined) return buffered;
      return await new Promise<OffsetRangeBatch | null>((resolve, reject) => {
        const listener = (): void => {
          const idx = waiters.findIndex((w) => w.resolve === resolve);
          if (idx >= 0) waiters.splice(idx, 1);
          resolve(null);
        };
        signal.addEventListener("abort", listener, { once: true });
        waiters.push({ resolve, reject, signal, listener });
      });
    },
    async release() {
      if (released) return;
      released = true;
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        if (waiter !== undefined) {
          waiter.signal.removeEventListener("abort", waiter.listener);
          waiter.resolve(null);
        }
      }
      try {
        await consumer.stop();
      } catch {
        // KafkaJS throws "consumer is not running" if `run` never
        // completed startup. The release path swallows it on purpose.
      }
      if (disconnectOnRelease) {
        try {
          await consumer.disconnect();
        } catch {
          // Same idempotency dance as `stop`.
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toBigInt(value: string | number | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  return BigInt(value);
}

function toBatch(payload: EachBatchPayload): OffsetRangeBatch {
  return {
    topic: payload.batch.topic,
    partition: payload.batch.partition,
    highWatermark: payload.batch.highWatermark,
    messages: payload.batch.messages.map(toMessage),
  };
}

function toMessage(message: KafkaMessage): OffsetRangeBatchMessage {
  const out: {
    offset: string;
    key: Buffer | string | null;
    value: Buffer | null;
    headers?: Record<string, Buffer | string | (string | Buffer)[] | undefined>;
    timestamp?: string;
  } = {
    offset: message.offset,
    key: message.key === null ? null : (message.key as Buffer | string),
    value: message.value,
  };
  if (message.headers !== undefined) {
    out.headers = message.headers as Record<
      string,
      Buffer | string | (string | Buffer)[] | undefined
    >;
  }
  if (typeof message.timestamp === "string") {
    out.timestamp = message.timestamp;
  }
  return out;
}

function projectMessage(
  topic: string,
  partition: number,
  message: OffsetRangeBatchMessage,
): OffsetRangeEvent | null {
  if (message.value === null) return null;

  const headers = stringifyHeaders(message.headers);
  const eventId = readHeaderString(message.headers, POLARIS_HEADER_EVENT_ID);
  const eventName = readHeaderString(message.headers, POLARIS_HEADER_EVENT_NAME);
  const projectId = readHeaderString(message.headers, POLARIS_HEADER_PROJECT_ID);
  const environment = readHeaderString(message.headers, POLARIS_HEADER_ENVIRONMENT);
  const occurredAt = readHeaderString(message.headers, POLARIS_HEADER_OCCURRED_AT);

  if (
    eventId === undefined ||
    eventName === undefined ||
    projectId === undefined ||
    environment === undefined ||
    occurredAt === undefined
  ) {
    return null;
  }

  return {
    topic,
    partition,
    offset: message.offset,
    event_id: eventId,
    event_name: eventName,
    project_id: projectId,
    environment,
    occurred_at: occurredAt,
    partition_key: keyToString(message.key),
    value: toUint8Array(message.value),
    headers,
  };
}

function keyToString(key: Buffer | string | null): string {
  if (key === null) return "";
  if (typeof key === "string") return key;
  return key.toString("utf8");
}

function toUint8Array(value: Buffer): Uint8Array {
  // Buffer extends Uint8Array but downstream consumers may not be in a
  // Node context. Slicing the underlying buffer ensures we hand back a
  // plain `Uint8Array` regardless.
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function stringifyHeaders(
  headers: Record<string, Buffer | string | (string | Buffer)[] | undefined> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === undefined) return out;
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (typeof value === "string") {
      out[key] = value;
      continue;
    }
    if (Buffer.isBuffer(value)) {
      out[key] = value.toString("utf8");
      continue;
    }
    if (Array.isArray(value)) {
      // Polaris headers do not use array values; if a producer emits one
      // anyway, the reader picks the last element so the result is still
      // a `Record<string, string>`.
      const last = value[value.length - 1];
      if (last === undefined) continue;
      out[key] = typeof last === "string" ? last : last.toString("utf8");
    }
  }
  return out;
}
