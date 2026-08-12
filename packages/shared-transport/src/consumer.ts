/**
 * Polaris consumer.
 *
 * Reads one or more super streams with a **static partition assignment**
 * and a Polaris-owned checkpoint, plus (optionally) the component's
 * redelivery queue.
 *
 * ## Why static assignment
 *
 * Kafka consumer groups rebalance: the coordinator hands partitions out
 * and takes them back as members come and go. RabbitMQ streams over AMQP
 * have no equivalent — a consumer names the stream it wants. Polaris
 * therefore assigns partitions from config (`POLARIS_RABBITMQ_ASSIGNED_PARTITIONS`)
 * and each instance owns exactly the partitions it was given. Scaling out
 * is a config change plus a restart, which is documented in
 * `docs/operations/runbook-processor-lag.md`. The upside is that there is
 * no rebalance storm, no stop-the-world pause, and no "who owns what?"
 * ambiguity during an incident.
 *
 * ## Ordering and concurrency
 *
 * One channel per partition stream, and messages within a partition are
 * handled strictly in order: the delivery callback chains onto a
 * per-partition promise. Prefetch controls how far the broker runs ahead,
 * not how many handlers run at once. Per-identity ordering — the property
 * the partition key exists to protect — therefore survives.
 *
 * ## Failure handling
 *
 * A handler that throws means "not processed". The consumer does not ack,
 * cancels the stream consumer, and re-attaches at `checkpoint + 1` after a
 * backoff — the message is redelivered. This is the closest faithful
 * mapping of KafkaJS's "throw and the batch is retried" that streams
 * allow (`basic.nack` with requeue is not meaningful on a stream, where
 * nothing is ever removed). Components that want retry/DLQ routing rather
 * than redelivery catch the error themselves and call `./dlq`.
 *
 * ## Poison messages
 *
 * Redelivering forever is the wrong answer for a message that can never
 * succeed: one bad payload would pin its partition indefinitely, and
 * every healthy event behind it would wait with it. So a message that
 * fails `maxDeliveryAttempts` times in a row at the *same offset* is
 * routed to the component's DLQ and skipped, exactly as an exhausted
 * retry would be.
 *
 * That needs a `poison` handle (component name + producer). Without one
 * the consumer keeps rewinding — but it escalates the log and emits
 * `consumer.poisoned` so the stall is visible rather than silent. Every
 * Polaris component wires the handle; the option is optional only so the
 * port stays usable without a producer.
 */

import { partitionsForFamily } from "@polaris/shared-config";
import type { Logger } from "@polaris/shared-logger";
import type { Channel, ConsumeMessage } from "amqplib";
import type { CheckpointStore } from "./checkpoints.js";
import type { TransportConnection } from "./connection.js";
import { republishToDlq } from "./dlq.js";
import {
  fromAmqpHeaders,
  POLARIS_HEADER_ENVIRONMENT,
  POLARIS_HEADER_EVENT_ID,
  POLARIS_HEADER_PROJECT_ID,
  POLARIS_HEADER_TOPIC_FAMILY,
  readHeaderString,
} from "./headers.js";
import { emitHook, type TransportHookPayload, type TransportHooks } from "./hooks.js";
import type { PolarisProducer } from "./producer.js";
import { partitionStreamName } from "./streams.js";
import type {
  TransportMessage,
  TransportMessageContext,
  TransportMessageHandler,
  TransportMessagePayload,
} from "./types.js";

/** Where a consumer attaches when it has no checkpoint for a stream. */
export type StreamStartPosition = "first" | "next";

/** Partition index reported for messages that did not come from a stream. */
export const QUEUE_PARTITION = -1;

export interface CreatePolarisConsumerOptions {
  /** Supervised RabbitMQ connection. */
  readonly connection: TransportConnection;
  /**
   * Polaris consumer-group identifier, e.g. `sessionizer-v1`. Namespaces
   * this consumer's checkpoints. Changing it rewinds the consumer.
   */
  readonly groupName: string;
  /** Durable checkpoint store. */
  readonly checkpoints: CheckpointStore;
  /** Optional metrics/logging hooks. */
  readonly hooks?: TransportHooks;
  /** Optional logger for lifecycle lines. */
  readonly logger?: Logger;
  /** Consumer identity stamped on log lines (e.g. `meta-capi`). */
  readonly consumerName?: string;
  /** Consumer version (e.g. `v1`). */
  readonly consumerVersion?: string;
  /**
   * Where to attach when a stream has no checkpoint. `next` (default)
   * means a brand-new consumer reads only new traffic — matching the old
   * `fromBeginning: false`. `first` replays the whole retention window.
   */
  readonly startPosition?: StreamStartPosition;
  /** Per-partition prefetch. Defaults to the configured value. */
  readonly prefetch?: number;
  /** Backoff applied before re-attaching after a handler failure. */
  readonly retryDelayMs?: number;
  /** Maximum backoff between re-attach attempts. */
  readonly maxRetryDelayMs?: number;
  /**
   * Consecutive failures at the same offset before the message is treated
   * as poison. Defaults to 5.
   */
  readonly maxDeliveryAttempts?: number;
  /**
   * Where to send a poison message. Without this the consumer cannot skip
   * one safely — it would have to choose between losing the event and
   * stalling the partition — so it keeps rewinding and escalates the log
   * instead.
   */
  readonly poison?: PoisonHandle;
}

/** Component identity + producer used to DLQ a poison message. */
export interface PoisonHandle {
  /** Component name; the DLQ queue is `<component>.dlq`. */
  readonly component: string;
  /** Connected producer used for the DLQ publish. */
  readonly producer: PolarisProducer;
  /**
   * Optional ledger write, called after the DLQ publish succeeds.
   *
   * Without it a dead-lettered message exists only as bytes on a queue, and
   * `polaris processors dlq list/show/retry` reads a permanently empty table —
   * an operator surface for an incident it cannot see. A callback rather than
   * a repository because the ledger lives in `@polaris/shared-processor`,
   * which depends on this package; taking the dependency the other way would
   * close a cycle.
   *
   * Must not throw: it is bookkeeping, and losing it may not stop the
   * partition from draining past a message it has already dead-lettered.
   */
  readonly record?: (input: PoisonRecord) => Promise<void>;
}

/** What the ledger is told about a dead-lettered message. */
export interface PoisonRecord {
  readonly component: string;
  readonly sourceTopic: string;
  readonly sourcePartition: number;
  readonly sourceOffset: string;
  readonly attempts: number;
  readonly reason: string;
  readonly errorClass: string;
  readonly errorMessage: string;
  /** Header values coerced to strings; the ledger column is text. */
  readonly headers: Readonly<Record<string, string>>;
  readonly value: Buffer | undefined;
}

/** Streams to read, expressed as families plus a partition assignment. */
export interface SubscribeInput {
  /**
   * Super-stream families to read (already isolation-resolved — use
   * `consumerFamiliesFor` to expand a family plus its isolated projects).
   */
  readonly families: ReadonlyArray<string>;
  /**
   * Partitions this instance owns. Defaults to the configured assignment,
   * and to "every partition" when that is empty.
   */
  readonly partitions?: ReadonlyArray<number>;
  /**
   * Plain queues to consume alongside the streams — in practice the
   * component's `<component>.redeliver` queue.
   */
  readonly queues?: ReadonlyArray<string>;
}

export interface PolarisConsumer {
  /** Resolve the assignment and record what will be read. */
  subscribe(input: SubscribeInput): Promise<void>;
  /** Start delivering messages to `handler`. Idempotent. */
  runEach(handler: TransportMessageHandler): Promise<void>;
  /** Stop consuming and release all channels. Idempotent. */
  disconnect(): Promise<void>;
  /** Concrete partition streams this consumer reads. */
  readonly streams: ReadonlyArray<string>;
  /** Plain queues this consumer reads. */
  readonly queues: ReadonlyArray<string>;
}

interface Reader {
  /** Stream or queue name. */
  readonly source: string;
  readonly kind: "stream" | "queue";
  readonly family: string;
  readonly partition: number;
  channel: Channel | undefined;
  consumerTag: string | undefined;
  /** Serializes handler invocations for this source. */
  chain: Promise<void>;
  /** Offset of the last successfully handled message (streams only). */
  lastOffset: string | undefined;
  /** Messages handled since the last checkpoint write. */
  sinceCheckpoint: number;
  /** Wall-clock of the last checkpoint write. */
  lastCheckpointAt: number;
  stopped: boolean;
  reattachAttempt: number;
  /**
   * Incremented on every attach and detach. Deliveries captured under an
   * older epoch are discarded — see `attach`.
   */
  epoch: number;
  /** Offset currently failing, and how many times in a row it has. */
  poisonOffset: string | undefined;
  poisonAttempts: number;
}

export function createPolarisConsumer(options: CreatePolarisConsumerOptions): PolarisConsumer {
  const { connection, groupName, checkpoints, hooks, logger, consumerName, consumerVersion } =
    options;
  const config = connection.config;
  const prefetch = options.prefetch ?? config.prefetch;
  const startPosition: StreamStartPosition = options.startPosition ?? "next";
  const baseRetryDelayMs = options.retryDelayMs ?? 1_000;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
  const maxDeliveryAttempts = options.maxDeliveryAttempts ?? 5;
  const poison = options.poison;

  const readers = new Map<string, Reader>();
  let handler: TransportMessageHandler | undefined;
  let running = false;
  let stopped = false;

  connection.onReconnected(async () => {
    if (!running || stopped) return;
    logger?.info(
      { component: "transport.consumer", consumer: consumerName, group_id: groupName },
      "reconnected; re-attaching readers at their checkpoints",
    );
    for (const reader of readers.values()) {
      reader.channel = undefined;
      reader.consumerTag = undefined;
      await attach(reader).catch((err: unknown) => {
        const error = err as Error;
        logger?.error(
          {
            component: "transport.consumer",
            source: reader.source,
            err: { name: error.name, message: error.message },
          },
          "re-attach after reconnect failed",
        );
      });
    }
  });

  function baseHookPayload(reader: Reader, message: TransportMessage): TransportHookPayload {
    const context = extractContext(message.headers);
    const out: Record<string, unknown> = {
      topic: reader.source,
      topic_family: reader.family,
      partition: reader.partition,
      offset: message.offset,
      group_id: groupName,
    };
    if (context.event_id !== undefined) out["event_id"] = context.event_id;
    if (context.project_id !== undefined) out["project_id"] = context.project_id;
    if (context.environment !== undefined) out["environment"] = context.environment;
    if (message.value !== null) out["bytes"] = message.value.length;
    return out as TransportHookPayload;
  }

  async function saveCheckpoint(reader: Reader, force: boolean): Promise<void> {
    if (reader.kind !== "stream") return;
    if (reader.lastOffset === undefined) return;
    const dueByCount = reader.sinceCheckpoint >= config.checkpointEvery;
    const dueByTime = Date.now() - reader.lastCheckpointAt >= config.checkpointIntervalMs;
    if (!force && !dueByCount && !dueByTime) return;
    await checkpoints.write({
      group_name: groupName,
      stream: reader.source,
      last_offset: reader.lastOffset,
    });
    reader.sinceCheckpoint = 0;
    reader.lastCheckpointAt = Date.now();
    emitHook(hooks, "consumer.checkpoint_saved", {
      topic: reader.source,
      topic_family: reader.family,
      partition: reader.partition,
      offset: reader.lastOffset,
      group_id: groupName,
    });
  }

  /**
   * Handle one delivery. Runs inside the reader's serial chain, so
   * `await`ing here is what preserves per-partition ordering.
   */
  async function deliver(reader: Reader, raw: ConsumeMessage, epoch: number): Promise<void> {
    if (reader.stopped || handler === undefined) return;
    // A delivery from a cancelled consumer. The broker pushes up to
    // `prefetch` messages ahead of the handler, so a rewind always leaves
    // some already queued; processing them would defeat the rewind
    // entirely — they sit AFTER the message that just failed, so handling
    // them would advance the checkpoint past it and silently skip it.
    if (reader.epoch !== epoch) return;
    const message = toTransportMessage(reader, raw);
    const payload: TransportMessagePayload = {
      stream: reader.source,
      family: reader.family,
      partition: reader.partition,
      message,
    };
    const context = extractContext(message.headers);
    const base = baseHookPayload(reader, message);
    const start = Date.now();
    emitHook(hooks, "consumer.message_received", base);
    try {
      await handler(payload, context);
    } catch (err) {
      await onHandlerFailed(reader, raw, payload, message, base, start, err);
      return;
    }

    // Past this line the message IS handled: the side effects ran and any
    // derived event is published. Nothing below may route it to a DLQ or
    // rewind to replay it — doing so would re-apply work that already
    // succeeded. This split is the point of the two blocks: a checkpoint
    // write is a CONTROL-PLANE operation, and a PostgreSQL fault used to
    // land in the handler's catch, where it counted as a poison attempt.
    // Five faults dead-lettered a healthy message after re-publishing its
    // output five times.
    reader.channel?.ack(raw);
    reader.poisonOffset = undefined;
    reader.poisonAttempts = 0;
    if (reader.kind === "stream") {
      reader.lastOffset = message.offset;
      reader.sinceCheckpoint += 1;
      try {
        await saveCheckpoint(reader, false);
      } catch (err) {
        // The position is lost, not the work. Stop the reader rather than
        // consume further on a stale checkpoint: a crash now would resume
        // from the last durable position and redo everything since. A
        // visible stall is the honest outcome, and it matches the rewind
        // path's existing preference for stalling over silent loss.
        await pauseOnCheckpointFailure(reader, message.offset, err as Error);
        return;
      }
    }
    emitHook(hooks, "consumer.message_handled", {
      ...base,
      duration_ms: Date.now() - start,
    });
  }

  /**
   * The handler itself failed: the message is NOT processed. Retry, poison
   * or rewind all apply here and only here.
   */
  async function onHandlerFailed(
    reader: Reader,
    raw: ConsumeMessage,
    payload: TransportMessagePayload,
    message: TransportMessage,
    base: ReturnType<typeof baseHookPayload>,
    start: number,
    err: unknown,
  ): Promise<void> {
    {
      const error = err as Error;
      emitHook(hooks, "consumer.handler_failed", {
        ...base,
        duration_ms: Date.now() - start,
        error_class: error.name,
        error_message: error.message,
      });
      if (reader.kind === "queue") {
        // Quorum queues carry a delivery limit and dead-letter poison
        // messages, so a requeue here is bounded.
        logger?.error(
          {
            component: "transport.consumer",
            consumer: consumerName,
            group_id: groupName,
            source: reader.source,
            err: { name: error.name, message: error.message },
          },
          "handler failed; requeueing",
        );
        reader.channel?.nack(raw, false, true);
        return;
      }

      // Count consecutive failures at this exact offset. A different
      // offset means progress, so the counter restarts.
      if (reader.poisonOffset === message.offset) {
        reader.poisonAttempts += 1;
      } else {
        reader.poisonOffset = message.offset;
        reader.poisonAttempts = 1;
      }

      if (reader.poisonAttempts >= maxDeliveryAttempts) {
        const skipped = await skipPoison(reader, raw, payload, error);
        if (skipped) return;
      }

      logger?.error(
        {
          component: "transport.consumer",
          consumer: consumerName,
          consumer_version: consumerVersion,
          group_id: groupName,
          source: reader.source,
          partition: reader.partition,
          offset: message.offset,
          delivery_attempts: reader.poisonAttempts,
          err: { name: error.name, message: error.message },
        },
        "handler failed; rewinding to checkpoint",
      );
      await rewind(reader);
    }
  }

  /**
   * A message was handled but its checkpoint could not be persisted.
   *
   * Cancels the consumer so nothing further is delivered on a position the
   * durable store does not know about. Recovery is an operator restart (or
   * the existing reattach path on the next epoch) once PostgreSQL is back;
   * the message itself needs nothing, because it is already done.
   */
  async function pauseOnCheckpointFailure(
    reader: Reader,
    offset: string,
    error: Error,
  ): Promise<void> {
    emitHook(hooks, "consumer.checkpoint_failed", {
      topic: reader.source,
      topic_family: reader.family,
      partition: reader.partition,
      offset,
      group_id: groupName,
      error_class: error.name,
      error_message: error.message,
    });
    logger?.error(
      {
        component: "transport.consumer",
        consumer: consumerName,
        group_id: groupName,
        source: reader.source,
        partition: reader.partition,
        offset,
        err: { name: error.name, message: error.message },
      },
      "checkpoint write failed after a handled message; pausing the reader",
    );
    reader.stopped = true;
    await detach(reader);
  }

  /**
   * Route a message that keeps failing to the component's DLQ, then skip
   * past it so the partition drains.
   *
   * Returns false when there is no DLQ to route to — the caller then
   * falls back to rewinding, because dropping the event silently would be
   * worse than a visible stall.
   */
  async function skipPoison(
    reader: Reader,
    raw: ConsumeMessage,
    payload: TransportMessagePayload,
    error: Error,
  ): Promise<boolean> {
    const base = {
      topic: reader.source,
      topic_family: reader.family,
      partition: reader.partition,
      offset: payload.message.offset,
      group_id: groupName,
      attempt: reader.poisonAttempts,
      error_class: error.name,
      error_message: error.message,
    };
    if (poison === undefined) {
      emitHook(hooks, "consumer.poisoned", base);
      logger?.error(
        {
          component: "transport.consumer",
          consumer: consumerName,
          group_id: groupName,
          source: reader.source,
          partition: reader.partition,
          offset: payload.message.offset,
          delivery_attempts: reader.poisonAttempts,
          err: { name: error.name, message: error.message },
        },
        "message has failed repeatedly and no DLQ is wired: this partition is STALLED and will not advance until the message succeeds or an operator intervenes",
      );
      return false;
    }

    try {
      await republishToDlq(poison.producer, {
        component: poison.component,
        value: payload.message.value,
        ...(payload.message.key !== null ? { key: payload.message.key } : {}),
        headers: payload.message.headers,
        sourceTopic: reader.source,
        sourcePartition: reader.partition,
        sourceOffset: payload.message.offset,
        reason: "poison_message",
        errorClass: error.name,
        errorMessage: error.message,
        failedAt: new Date().toISOString(),
      });
      // Bytes are on the queue; now make the incident visible to the operator
      // surface. Failures here are logged and swallowed — the message is
      // already dead-lettered, and refusing to advance would stall the
      // partition over bookkeeping.
      if (poison.record !== undefined) {
        try {
          await poison.record({
            component: poison.component,
            sourceTopic: reader.source,
            sourcePartition: reader.partition,
            sourceOffset: payload.message.offset,
            attempts: reader.poisonAttempts,
            reason: "poison_message",
            errorClass: error.name,
            errorMessage: error.message,
            headers: stringifyHeaders(payload.message.headers),
            value: payload.message.value ?? undefined,
          });
        } catch (recordErr) {
          const recordError = recordErr as Error;
          logger?.error(
            {
              component: "transport.consumer",
              consumer: consumerName,
              source: reader.source,
              partition: reader.partition,
              offset: payload.message.offset,
              err: { name: recordError.name, message: recordError.message },
            },
            "dead-lettered message could not be recorded in the DLQ ledger; the bytes are on the queue but `processors dlq list` will not show it",
          );
        }
      }
    } catch (dlqErr) {
      const dlqError = dlqErr as Error;
      logger?.error(
        {
          component: "transport.consumer",
          source: reader.source,
          offset: payload.message.offset,
          err: { name: dlqError.name, message: dlqError.message },
        },
        "DLQ publish failed for a poison message; rewinding instead of skipping",
      );
      return false;
    }

    // The event is durable in the DLQ, so advancing past it loses nothing.
    reader.channel?.ack(raw);
    reader.lastOffset = payload.message.offset;
    reader.sinceCheckpoint += 1;
    reader.poisonOffset = undefined;
    reader.poisonAttempts = 0;
    await saveCheckpoint(reader, true);
    emitHook(hooks, "consumer.poisoned", base);
    logger?.error(
      {
        component: "transport.consumer",
        consumer: consumerName,
        group_id: groupName,
        source: reader.source,
        partition: reader.partition,
        offset: payload.message.offset,
        delivery_attempts: maxDeliveryAttempts,
        dlq_queue: `${poison.component}.dlq`,
        err: { name: error.name, message: error.message },
      },
      "message failed repeatedly; routed to DLQ and skipped so the partition can advance",
    );
    return true;
  }

  /**
   * Detach a stream reader and re-attach it at its checkpoint after a
   * backoff. Everything after the failed offset is redelivered.
   */
  async function rewind(reader: Reader): Promise<void> {
    if (reader.stopped) return;
    await detach(reader);
    if (stopped) return;
    // Back off on whichever counter is higher. `reattachAttempt` resets on
    // a successful attach, so on its own it would never grow for a poison
    // message — attach succeeds every time, the delivery is what fails.
    const attempt = Math.max(reader.reattachAttempt, reader.poisonAttempts);
    const delay = Math.min(baseRetryDelayMs * 2 ** attempt, maxRetryDelayMs);
    reader.reattachAttempt += 1;
    emitHook(hooks, "consumer.rewound", {
      topic: reader.source,
      topic_family: reader.family,
      partition: reader.partition,
      group_id: groupName,
      ...(reader.lastOffset !== undefined ? { offset: reader.lastOffset } : {}),
      attempt: reader.reattachAttempt,
    });
    await sleep(delay);
    if (stopped || reader.stopped) return;
    await attach(reader).catch((err: unknown) => {
      const error = err as Error;
      logger?.error(
        {
          component: "transport.consumer",
          source: reader.source,
          err: { name: error.name, message: error.message },
        },
        "re-attach failed; retrying",
      );
      void rewind(reader);
    });
  }

  /** Open a channel for a reader and start consuming. */
  async function attach(reader: Reader): Promise<void> {
    if (stopped || reader.stopped) return;
    const channel = await connection.createChannel();
    reader.channel = channel;
    channel.on("error", (err: Error) => {
      logger?.warn(
        {
          component: "transport.consumer",
          source: reader.source,
          err: { name: err.name, message: err.message },
        },
        "consumer channel error",
      );
    });
    await channel.prefetch(prefetch);

    const consumeOptions: { noAck: false; arguments?: Record<string, unknown> } = { noAck: false };
    if (reader.kind === "stream") {
      const stored = await checkpoints.read(groupName, reader.source);
      reader.lastOffset = stored;
      consumeOptions.arguments = { "x-stream-offset": offsetSpec(stored, startPosition) };
    }

    // Every attach gets its own epoch so deliveries buffered against a
    // previous one can be told apart and dropped.
    reader.epoch += 1;
    const epoch = reader.epoch;

    const reply = await channel.consume(
      reader.source,
      (raw) => {
        if (raw === null) return;
        reader.chain = reader.chain
          .then(() => deliver(reader, raw, epoch))
          .catch((err: unknown) => {
            const error = err as Error;
            logger?.error(
              {
                component: "transport.consumer",
                source: reader.source,
                err: { name: error.name, message: error.message },
              },
              "delivery chain error",
            );
          });
      },
      consumeOptions,
    );
    reader.consumerTag = reply.consumerTag;
    reader.reattachAttempt = 0;
    emitHook(hooks, "consumer.partition_assigned", {
      topic: reader.source,
      topic_family: reader.family,
      partition: reader.partition,
      group_id: groupName,
      ...(reader.lastOffset !== undefined ? { offset: reader.lastOffset } : {}),
    });
    logger?.info(
      {
        component: "transport.consumer",
        consumer: consumerName,
        consumer_version: consumerVersion,
        group_id: groupName,
        source: reader.source,
        partition: reader.partition,
        resume_offset: reader.lastOffset ?? startPosition,
      },
      "reader attached",
    );
  }

  /** Cancel and close a reader's channel, flushing its checkpoint. */
  async function detach(reader: Reader): Promise<void> {
    // Invalidate anything the broker already pushed to the old consumer.
    reader.epoch += 1;
    const channel = reader.channel;
    const tag = reader.consumerTag;
    reader.channel = undefined;
    reader.consumerTag = undefined;
    if (channel === undefined) return;
    try {
      if (tag !== undefined) await channel.cancel(tag);
      await saveCheckpoint(reader, true);
      await channel.close();
    } catch {
      // The channel may already be gone (connection drop); nothing to do.
    }
    emitHook(hooks, "consumer.partition_released", {
      topic: reader.source,
      topic_family: reader.family,
      partition: reader.partition,
      group_id: groupName,
    });
  }

  function resolveAssignment(input: SubscribeInput): void {
    const configured =
      input.partitions ??
      (config.assignedPartitions.length > 0 ? config.assignedPartitions : undefined);
    for (const family of input.families) {
      const width = partitionsForFamily(config, family);
      const owned = configured ?? range(width);
      for (const partition of owned) {
        if (partition >= width) {
          throw new Error(
            `consumer assignment: partition ${String(partition)} is outside "${family}" (${String(width)} partitions)`,
          );
        }
        const stream = partitionStreamName(family, partition);
        readers.set(stream, newReader(stream, "stream", family, partition));
      }
    }
    for (const queue of input.queues ?? []) {
      readers.set(queue, newReader(queue, "queue", queue, QUEUE_PARTITION));
    }
  }

  return {
    async subscribe(input: SubscribeInput): Promise<void> {
      resolveAssignment(input);
      logger?.info(
        {
          component: "transport.consumer",
          consumer: consumerName,
          group_id: groupName,
          streams: [...readers.values()].filter((r) => r.kind === "stream").map((r) => r.source),
          queues: [...readers.values()].filter((r) => r.kind === "queue").map((r) => r.source),
        },
        "consumer subscription resolved",
      );
    },
    async runEach(next: TransportMessageHandler): Promise<void> {
      if (running) return;
      handler = next;
      running = true;
      stopped = false;
      for (const reader of readers.values()) {
        await attach(reader);
      }
      emitHook(hooks, "consumer.connected", { group_id: groupName });
    },
    async disconnect(): Promise<void> {
      if (stopped) return;
      stopped = true;
      running = false;
      for (const reader of readers.values()) {
        reader.stopped = true;
        // Let the in-flight handler finish so its checkpoint is durable.
        await reader.chain.catch(() => undefined);
        await detach(reader);
      }
      emitHook(hooks, "consumer.disconnected", { group_id: groupName });
      logger?.info(
        { component: "transport.consumer", consumer: consumerName, group_id: groupName },
        "consumer disconnected",
      );
    },
    get streams(): ReadonlyArray<string> {
      return [...readers.values()].filter((r) => r.kind === "stream").map((r) => r.source);
    },
    get queues(): ReadonlyArray<string> {
      return [...readers.values()].filter((r) => r.kind === "queue").map((r) => r.source);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Coerce transport headers to the text shape the ledger column stores.
 *
 * Buffers become utf8, arrays take their first element, absent values are
 * dropped — the ledger is for an operator reading a triage page, not a
 * faithful byte record. The payload column keeps the original bytes.
 */
function stringifyHeaders(headers: Readonly<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    const first = Array.isArray(value) ? value[0] : value;
    if (first === undefined || first === null) continue;
    out[key] = Buffer.isBuffer(first) ? first.toString("utf8") : String(first);
  }
  return out;
}

function newReader(
  source: string,
  kind: "stream" | "queue",
  family: string,
  partition: number,
): Reader {
  return {
    source,
    kind,
    family,
    partition,
    channel: undefined,
    consumerTag: undefined,
    lastOffset: undefined,
    chain: Promise.resolve(),
    sinceCheckpoint: 0,
    lastCheckpointAt: Date.now(),
    stopped: false,
    reattachAttempt: 0,
    epoch: 0,
    poisonOffset: undefined,
    poisonAttempts: 0,
  };
}

/**
 * Build the `x-stream-offset` argument.
 *
 * A stored checkpoint resumes at `offset + 1` — the checkpoint is the last
 * offset that was *handled*, so re-reading it would double-process. With
 * no checkpoint the configured start position applies.
 *
 * The `{'!': 'long'}` wrapper is amqplib's explicit-type escape: a bare JS
 * number would be encoded as a 32-bit int and silently truncate once a
 * partition passes ~2.1 billion messages.
 */
export function offsetSpec(
  storedOffset: string | undefined,
  startPosition: StreamStartPosition,
): unknown {
  if (storedOffset === undefined) return startPosition;
  return { "!": "long", value: (BigInt(storedOffset) + 1n).toString() };
}

/** Project an AMQP delivery onto the broker-neutral message shape. */
function toTransportMessage(reader: Reader, raw: ConsumeMessage): TransportMessage {
  const headers = fromAmqpHeaders(raw.properties.headers);
  const offset =
    reader.kind === "stream"
      ? readStreamOffset(raw)
      : // Plain queues have no offset; the delivery tag is the closest
        // analogous position marker and is what DLQ records store.
        String(raw.fields.deliveryTag);
  const timestamp =
    typeof raw.properties.timestamp === "number"
      ? String(raw.properties.timestamp)
      : String(Date.now());
  return {
    value: raw.content,
    key: typeof raw.properties.messageId === "string" ? raw.properties.messageId : null,
    headers,
    offset,
    timestamp,
    redelivered: raw.fields.redelivered,
  };
}

/**
 * Read the stream offset RabbitMQ stamps on every stream delivery. Absence
 * means the source is not a stream, which the reader's `kind` should have
 * ruled out — falling back to the delivery tag keeps lineage non-empty
 * rather than crashing the pipeline over a metadata gap.
 */
function readStreamOffset(raw: ConsumeMessage): string {
  const value = raw.properties.headers?.["x-stream-offset"];
  if (typeof value === "number") return String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "value" in value) {
    return String((value as { value: unknown }).value);
  }
  return String(raw.fields.deliveryTag);
}

function extractContext(headers: TransportMessage["headers"]): TransportMessageContext {
  const context: Record<string, string> = {};
  const eventId = readHeaderString(headers, POLARIS_HEADER_EVENT_ID);
  if (eventId !== undefined) context["event_id"] = eventId;
  const projectId = readHeaderString(headers, POLARIS_HEADER_PROJECT_ID);
  if (projectId !== undefined) context["project_id"] = projectId;
  const environment = readHeaderString(headers, POLARIS_HEADER_ENVIRONMENT);
  if (environment !== undefined) context["environment"] = environment;
  const topicFamily = readHeaderString(headers, POLARIS_HEADER_TOPIC_FAMILY);
  if (topicFamily !== undefined) context["topic_family"] = topicFamily;
  return context as TransportMessageContext;
}

function range(count: number): ReadonlyArray<number> {
  return Array.from({ length: count }, (_unused, index) => index);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
