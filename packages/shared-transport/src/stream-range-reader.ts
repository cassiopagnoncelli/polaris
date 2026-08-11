/**
 * Stream range reader.
 *
 * Polaris replay turns a deterministic plan into a sequence of stream
 * reads + republished events. The plan owns the time window; the
 * `@polaris/shared-replay` executor walks the chunks; the **reader** in
 * this module is the only place that actually talks to a RabbitMQ
 * partition stream.
 *
 * ## What the RabbitMQ move changed
 *
 * Under Kafka this module read an **offset range**, and the CLI had to
 * translate the plan's time window into per-partition offsets first
 * (`admin.fetchTopicOffsetsByTimestamp`, one round trip per chunk per
 * partition, plus off-by-one handling because the response is
 * offset-exclusive). RabbitMQ streams accept a timestamp directly as the
 * attach point, so that entire translation layer is gone: the reader takes
 * the window and attaches at it.
 *
 * Attaching by timestamp is **chunk-granular** — RabbitMQ positions at the
 * start of the stream chunk containing the timestamp, so the reader can
 * see messages slightly older than `fromTimestampMs`. That is harmless:
 * the replay executor filters on the plan's scope and the chunk's
 * `occurred_at` bounds anyway, and the same dedupe layers that absorbed
 * the Kafka reader's high-water-mark clamp absorb this.
 *
 * ## Architectural rules baked into this module
 *
 *   - **No checkpoints, no groups.** The reader never writes a
 *     checkpoint, so a replay read cannot disturb a live consumer's
 *     position, and several replay readers can run in parallel.
 *
 *   - **Bounded by time and by the tail.** A replay window may run up to
 *     "now"; the reader stops at the first message past the window (plus
 *     slack) or after `idleTimeoutMs` of silence, so a replay never blocks
 *     waiting for new traffic.
 *
 *   - **Headers project through.** The reader extracts the standard
 *     Polaris platform headers onto typed fields the executor consumes;
 *     remaining headers pass through as `Record<string, string>`.
 *
 *   - **No driver types leak.** Callers do not see amqplib types. The
 *     reader takes a small `StreamRangeDriver` capability that real
 *     callers wire via `createAmqpStreamRangeDriver(connection)`; tests
 *     pass an in-memory fake.
 *
 * @see docs/architecture/05-processors-and-replay.md "Replay Control Plane"
 * @see packages/shared-replay/src/executor.ts (downstream consumer)
 */

import type { Channel } from "amqplib";
import type { TransportConnection } from "./connection.js";
import {
  fromAmqpHeaders,
  POLARIS_HEADER_ENVIRONMENT,
  POLARIS_HEADER_EVENT_ID,
  POLARIS_HEADER_EVENT_NAME,
  POLARIS_HEADER_INGESTED_AT,
  POLARIS_HEADER_OCCURRED_AT,
  POLARIS_HEADER_PROJECT_ID,
  type MessageHeaders,
  readHeaderString,
} from "./headers.js";
import { parsePartitionStreamName } from "./streams.js";

// ---------------------------------------------------------------------------
// Public input / output shapes
// ---------------------------------------------------------------------------

/**
 * A single event read from a source partition stream. Structurally
 * compatible with `@polaris/shared-replay`'s `ReplaySourceEvent` so a thin
 * adapter can hand the reader's output to the executor without a
 * field-by-field copy.
 *
 * `value` is `Uint8Array` (not `Buffer`) so the executor's pure module,
 * which does not depend on Node typings, can forward the bytes through.
 */
export interface StreamRangeEvent {
  /** Source partition stream the event was read from. */
  readonly stream: string;
  /** Partition index. */
  readonly partition: number;
  /** Stream offset, decimal string. Echoed for lineage / debug logging. */
  readonly offset: string;
  readonly event_id: string;
  readonly event_name: string;
  readonly project_id: string;
  readonly environment: string;
  readonly occurred_at: string;
  /** Partition key the event was originally published with. */
  readonly partition_key: string | null;
  readonly value: Uint8Array;
  /** Every header, stringified. */
  readonly headers: Record<string, string>;
}

/** Why a read stopped. */
export const STREAM_RANGE_TERMINATION_REASONS = [
  /** A message past the window (plus slack) was observed. */
  "window_complete",
  /** No message arrived within `idleTimeoutMs` — the tail was reached. */
  "idle_timeout",
  /** `maxEvents` was hit before the window ended. Caller should resume. */
  "max_events",
  /** The driver reported the channel closed mid-read. */
  "channel_closed",
] as const;

export type StreamRangeTerminationReason = (typeof STREAM_RANGE_TERMINATION_REASONS)[number];

export interface ReadStreamRangeInput {
  /** Concrete partition stream, e.g. `raw.events-2`. */
  readonly stream: string;
  /** Inclusive lower bound of the window, epoch milliseconds. */
  readonly fromTimestampMs: number;
  /** Inclusive upper bound of the window, epoch milliseconds. */
  readonly toTimestampMs: number;
  /**
   * Resume point. When present the reader attaches at this offset instead
   * of the window's timestamp — used by the executor to continue a read
   * that stopped on `max_events`.
   */
  readonly startOffset?: string;
  /** Stop after this many events. Default: unbounded. */
  readonly maxEvents?: number;
  /**
   * How long to wait for the next message before declaring the tail
   * reached. Default 5s.
   */
  readonly idleTimeoutMs?: number;
  /**
   * Extra time read past `toTimestampMs` before stopping. Events are
   * ordered in the stream by **ingestion** time, but the replay window is
   * evaluated against **occurred_at**; an event that arrived late sits
   * past the window's end in stream order while still belonging to it.
   * Default 15 minutes, which covers SDK retry buffers and mobile
   * offline batches.
   */
  readonly slackMs?: number;
}

export interface ReadStreamRangeResult {
  readonly events: ReadonlyArray<StreamRangeEvent>;
  readonly terminationReason: StreamRangeTerminationReason;
  /** Offset of the last event returned, or `undefined` when none were. */
  readonly lastOffset: string | undefined;
}

/** Default idle timeout: how long silence means "tail reached". */
export const DEFAULT_IDLE_TIMEOUT_MS = 5_000;
/** Default read-past-the-window slack. */
export const DEFAULT_SLACK_MS = 15 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Driver seam
// ---------------------------------------------------------------------------

/** One delivery handed up by the driver. */
export interface StreamRangeDelivery {
  readonly offset: string;
  /** Broker enqueue time, epoch milliseconds. */
  readonly timestampMs: number;
  readonly headers: MessageHeaders;
  readonly key: string | null;
  readonly value: Uint8Array;
}

/**
 * Capability the reader needs from the transport. Production wires
 * `createAmqpStreamRangeDriver`; tests pass an in-memory fake that calls
 * `onMessage` synchronously.
 */
export interface StreamRangeDriver {
  /**
   * Begin consuming `stream` at `offsetSpec`, delivering to `onMessage`.
   * `onClosed` fires if the underlying channel dies mid-read.
   */
  start(input: {
    readonly stream: string;
    readonly offsetSpec: unknown;
    readonly onMessage: (delivery: StreamRangeDelivery) => void;
    readonly onClosed: () => void;
  }): Promise<void>;
  /** Stop consuming and release resources. Idempotent. */
  release(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/**
 * Read every event in a time window from one partition stream.
 */
export async function readStreamRange(
  driver: StreamRangeDriver,
  input: ReadStreamRangeInput,
): Promise<ReadStreamRangeResult> {
  const parsed = parsePartitionStreamName(input.stream);
  const partition = parsed?.partition ?? 0;
  const idleTimeoutMs = input.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const slackMs = input.slackMs ?? DEFAULT_SLACK_MS;
  const stopAfterMs = input.toTimestampMs + slackMs;

  const events: StreamRangeEvent[] = [];
  let termination: StreamRangeTerminationReason | undefined;
  let lastOffset: string | undefined;

  let resolveDone: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  let idleTimer: NodeJS.Timeout | undefined;

  const finish = (reason: StreamRangeTerminationReason): void => {
    if (termination !== undefined) return;
    termination = reason;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    resolveDone?.();
  };

  const armIdleTimer = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      finish("idle_timeout");
    }, idleTimeoutMs);
    // The reader must not hold the process open on its own.
    idleTimer.unref?.();
  };

  const onMessage = (delivery: StreamRangeDelivery): void => {
    if (termination !== undefined) return;
    armIdleTimer();

    // Stream order is ingestion order, so the first message past the
    // window plus slack means everything after it is too.
    const messageTimeMs = ingestionTimeMs(delivery);
    if (messageTimeMs > stopAfterMs) {
      finish("window_complete");
      return;
    }

    const projected = toStreamRangeEvent(input.stream, partition, delivery);
    if (projected === undefined) {
      // A message without the platform headers cannot be scoped to a
      // plan; skipping keeps a foreign publish from failing the replay.
      return;
    }
    events.push(projected);
    lastOffset = projected.offset;

    if (input.maxEvents !== undefined && events.length >= input.maxEvents) {
      finish("max_events");
    }
  };

  await driver.start({
    stream: input.stream,
    offsetSpec: rangeOffsetSpec(input),
    onMessage,
    onClosed: () => {
      finish("channel_closed");
    },
  });
  armIdleTimer();

  try {
    await done;
  } finally {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    await driver.release();
  }

  return {
    events,
    terminationReason: termination ?? "idle_timeout",
    lastOffset,
  };
}

/**
 * Attach point for a range read: an explicit resume offset when the caller
 * has one, otherwise the window's start timestamp.
 *
 * RabbitMQ interprets an AMQP timestamp `x-stream-offset` as **seconds**
 * since the epoch, so the millisecond window bound is floored.
 */
export function rangeOffsetSpec(input: ReadStreamRangeInput): unknown {
  if (input.startOffset !== undefined) {
    return { "!": "long", value: input.startOffset };
  }
  return { "!": "timestamp", value: Math.floor(input.fromTimestampMs / 1000) };
}

/**
 * Build the production driver: one dedicated channel per read, cancelled
 * and closed on release.
 */
export function createAmqpStreamRangeDriver(
  connection: TransportConnection,
  prefetch = 500,
): StreamRangeDriver {
  let channel: Channel | undefined;
  let consumerTag: string | undefined;

  return {
    async start({ stream, offsetSpec, onMessage, onClosed }): Promise<void> {
      const next = await connection.createChannel();
      channel = next;
      next.on("close", onClosed);
      next.on("error", onClosed);
      await next.prefetch(prefetch);
      const reply = await next.consume(
        stream,
        (raw) => {
          if (raw === null) return;
          // Replay reads never checkpoint, but the broker still needs the
          // credit back or the read stalls at the prefetch window.
          next.ack(raw);
          onMessage({
            offset: readOffsetHeader(raw.properties.headers, raw.fields.deliveryTag),
            timestampMs:
              typeof raw.properties.timestamp === "number" ? raw.properties.timestamp : Date.now(),
            headers: fromAmqpHeaders(raw.properties.headers),
            key: typeof raw.properties.messageId === "string" ? raw.properties.messageId : null,
            value: raw.content,
          });
        },
        { noAck: false, arguments: { "x-stream-offset": offsetSpec } },
      );
      consumerTag = reply.consumerTag;
    },
    async release(): Promise<void> {
      const current = channel;
      const tag = consumerTag;
      channel = undefined;
      consumerTag = undefined;
      if (current === undefined) return;
      try {
        if (tag !== undefined) await current.cancel(tag);
        await current.close();
      } catch {
        // Already gone; nothing to release.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Ingestion time for windowing. `polaris-ingested-at` is authoritative
 * (it is what the ingester stamped); the broker timestamp is the fallback
 * for messages produced by tooling that did not stamp the header.
 */
function ingestionTimeMs(delivery: StreamRangeDelivery): number {
  const ingestedAt = readHeaderString(delivery.headers, POLARIS_HEADER_INGESTED_AT);
  if (ingestedAt !== undefined) {
    const parsed = Date.parse(ingestedAt);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return delivery.timestampMs;
}

function toStreamRangeEvent(
  stream: string,
  partition: number,
  delivery: StreamRangeDelivery,
): StreamRangeEvent | undefined {
  const eventId = readHeaderString(delivery.headers, POLARIS_HEADER_EVENT_ID);
  const eventName = readHeaderString(delivery.headers, POLARIS_HEADER_EVENT_NAME);
  const projectId = readHeaderString(delivery.headers, POLARIS_HEADER_PROJECT_ID);
  const environment = readHeaderString(delivery.headers, POLARIS_HEADER_ENVIRONMENT);
  const occurredAt = readHeaderString(delivery.headers, POLARIS_HEADER_OCCURRED_AT);
  if (
    eventId === undefined ||
    eventName === undefined ||
    projectId === undefined ||
    environment === undefined ||
    occurredAt === undefined
  ) {
    return undefined;
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(delivery.headers)) {
    if (value === undefined) continue;
    headers[key] = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  }
  return {
    stream,
    partition,
    offset: delivery.offset,
    event_id: eventId,
    event_name: eventName,
    project_id: projectId,
    environment,
    occurred_at: occurredAt,
    partition_key: delivery.key,
    value: delivery.value,
    headers,
  };
}

function readOffsetHeader(headers: unknown, fallback: number): string {
  if (headers !== null && typeof headers === "object") {
    const value = (headers as Record<string, unknown>)["x-stream-offset"];
    if (typeof value === "number") return String(value);
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "string") return value;
    if (typeof value === "object" && value !== null && "value" in value) {
      return String((value as { value: unknown }).value);
    }
  }
  return String(fallback);
}
