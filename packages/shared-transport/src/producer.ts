/**
 * Polaris producer.
 *
 * Publishes canonical events into a super stream. The producer:
 *
 *   - resolves a stream family to a concrete super stream via the
 *     isolation lookup,
 *   - derives the partition key from the envelope and hashes it to a
 *     partition index (the super-stream exchange's routing key),
 *   - serializes the envelope, stamps Polaris headers,
 *   - publishes on a **confirm channel** and awaits the broker ack.
 *
 * Waiting for confirms is the RabbitMQ equivalent of `acks=all`, and it is
 * not optional here: `basic.publish` is fire-and-forget, so without
 * confirms a publish to a full or unroutable exchange returns success
 * while the event is gone. The ingester's whole contract is "202 means
 * durable", so every publish awaits its confirm.
 *
 * Unroutable publishes are treated as failures via `mandatory: true` plus
 * a `return` listener — that is the only way to notice a missing binding,
 * which is exactly what a partial topology looks like.
 */

import { partitionsForFamily } from "@polaris/shared-config";
import type { Logger } from "@polaris/shared-logger";
import type { ConfirmChannel } from "amqplib";
import type { TransportConnection } from "./connection.js";
import {
  buildEventHeaders,
  type MessageHeaders,
  mergeHeaders,
  type PolarisHeaderInput,
  toAmqpHeaders,
} from "./headers.js";
import { emitHook, type TransportHooks } from "./hooks.js";
import {
  buildRawEventsPartitionKey,
  type PartitionKeyIdentity,
  partitionForKey,
} from "./partition-key.js";
import { encodeEvent } from "./serialization.js";
import { resolveStreamFamilySync, type SyncIsolationLookup } from "./stream-family.js";
import { type CanonicalStreamFamily, partitionStreamName, streamExchangeName } from "./streams.js";
import type { PublishResult } from "./types.js";

/**
 * Options accepted by `createPolarisProducer`.
 */
export interface CreatePolarisProducerOptions {
  /** Supervised RabbitMQ connection. */
  readonly connection: TransportConnection;
  /** Optional metrics/logging hooks. */
  readonly hooks?: TransportHooks;
  /** Optional logger for lifecycle lines. */
  readonly logger?: Logger;
  /** Producer identity stamped into headers. Required for traceability. */
  readonly producerName: string;
  /** Producer version stamped into headers (e.g. package version). */
  readonly producerVersion?: string;
}

/** Polaris producer surface. */
export interface PolarisProducer {
  /** Open the publish channel. Idempotent. */
  connect(): Promise<void>;
  /** Close the publish channel. Idempotent. Does not close the connection. */
  disconnect(): Promise<void>;
  /**
   * Publish a canonical event to a Polaris stream family.
   *
   * Resolves the family through the sync `IsolationLookup` (the hot path
   * expects a cached/memoized lookup), computes the partition key from the
   * envelope, and awaits the broker confirm.
   */
  publishEvent(input: PublishEventInput): Promise<PublishResult>;
  /**
   * Publish pre-built bytes to an explicit family. Used by retry/DLQ
   * republishing and by components emitting non-canonical payloads.
   */
  publish(input: PublishInput): Promise<PublishResult>;
  /**
   * Publish directly to a queue, bypassing super-stream routing. This is
   * the retry/redeliver/DLQ path: those are quorum queues, not streams.
   */
  publishToQueue(input: PublishToQueueInput): Promise<void>;
}

/** Minimum event shape required to publish. */
export interface PublishableEvent {
  readonly event_id: string;
  readonly event: string;
  readonly schema_version: number;
  readonly project_id: string;
  readonly environment: string;
  readonly occurred_at: string;
  readonly ingested_at?: string;
  readonly source?: { readonly id?: string | undefined } | undefined;
  readonly identity: PartitionKeyIdentity;
  // The full envelope contains more fields; they pass through
  // serialization untouched. Producers should hand `publishEvent` the
  // complete envelope.
  readonly [extra: string]: unknown;
}

export interface PublishEventInput {
  /** Canonical stream family — one of `STREAM_FAMILY_*` constants. */
  readonly family: CanonicalStreamFamily;
  /** Pre-stamped canonical envelope (or compatible payload). */
  readonly event: PublishableEvent;
  /**
   * Sync isolation lookup. Hot paths should pass a cache-backed handle.
   * Use `resolveStreamFamily` + `publish` for the rare async-lookup case.
   */
  readonly isolation: SyncIsolationLookup;
  /** Optional extra headers merged after Polaris defaults. */
  readonly extraHeaders?: MessageHeaders;
  /**
   * Override the partition key. Defaults to the canonical
   * project/env/identity key from `buildRawEventsPartitionKey`.
   */
  readonly partitionKey?: string;
}

export interface PublishInput {
  /** Concrete super-stream family name (already isolation-resolved). */
  readonly family: string;
  /** Message body. */
  readonly value: Buffer;
  /** Partition key. `null` routes to partition 0. */
  readonly partitionKey: string | null;
  /** Headers to stamp. */
  readonly headers?: MessageHeaders;
}

export interface PublishToQueueInput {
  /** Target queue name (retry tier, redeliver, or DLQ). */
  readonly queue: string;
  readonly value: Buffer;
  readonly headers?: MessageHeaders;
  /** Optional partition key preserved through the retry hop. */
  readonly partitionKey?: string | null;
}

/**
 * Build a Polaris producer.
 */
export function createPolarisProducer(options: CreatePolarisProducerOptions): PolarisProducer {
  const { connection, hooks, logger, producerName, producerVersion } = options;
  const config = connection.config;

  let channel: ConfirmChannel | undefined;
  let opening: Promise<ConfirmChannel> | undefined;
  let closed = false;

  // A `basic.return` means the broker could not route the message — a
  // missing binding or a super stream that was never declared. The
  // publish's confirm still succeeds (RabbitMQ acks returned messages),
  // so the return has to be captured out of band and surfaced on the next
  // publish rather than silently swallowed.
  interface UnroutableReturn {
    readonly exchange: string;
    readonly routingKey: string;
  }
  const returnState: { current: UnroutableReturn | undefined } = { current: undefined };

  /** Take and clear the pending unroutable return, if any. */
  function takeReturn(): UnroutableReturn | undefined {
    const value = returnState.current;
    returnState.current = undefined;
    return value;
  }

  connection.onReconnected(() => {
    // Force a fresh channel on the new connection; the old one is dead.
    channel = undefined;
    opening = undefined;
  });

  async function openChannel(): Promise<ConfirmChannel> {
    if (closed) throw new Error("polaris producer: already disconnected");
    if (channel !== undefined) return channel;
    if (opening !== undefined) return opening;
    opening = (async (): Promise<ConfirmChannel> => {
      const next = await connection.createConfirmChannel();
      next.on("return", (message) => {
        returnState.current = {
          exchange: message.fields.exchange,
          routingKey: message.fields.routingKey,
        };
        logger?.error(
          {
            component: "transport.producer",
            producer: producerName,
            exchange: message.fields.exchange,
            routing_key: message.fields.routingKey,
          },
          "publish returned as unroutable",
        );
      });
      next.on("close", () => {
        if (channel === next) channel = undefined;
      });
      next.on("error", (err: Error) => {
        logger?.warn(
          {
            component: "transport.producer",
            producer: producerName,
            err: { name: err.name, message: err.message },
          },
          "producer channel error",
        );
      });
      channel = next;
      emitHook(hooks, "producer.connected", { client_id: config.clientId });
      logger?.info({ component: "transport.producer", producer: producerName }, "producer connected");
      return next;
    })().finally(() => {
      opening = undefined;
    });
    return opening;
  }

  async function publishConfirmed(
    exchange: string,
    routingKey: string,
    value: Buffer,
    headers: MessageHeaders | undefined,
    partitionKey: string | null,
    hookTopic: string,
    hookFamily: string | undefined,
  ): Promise<void> {
    const active = await openChannel();
    const start = Date.now();
    takeReturn();
    try {
      await new Promise<void>((resolve, reject) => {
        const options: Parameters<ConfirmChannel["publish"]>[3] = {
          persistent: true,
          mandatory: true,
          contentType: "application/json",
          timestamp: Date.now(),
          appId: producerName,
          headers: toAmqpHeaders(headers),
        };
        if (partitionKey !== null) {
          // AMQP has no key field; `messageId` is the conventional slot
          // for a publisher-assigned identifier and is what the consumer
          // reads back as `message.key`.
          options.messageId = partitionKey;
        }
        active.publish(exchange, routingKey, value, options, (err) => {
          if (err !== null && err !== undefined) {
            reject(err instanceof Error ? err : new Error(String(err)));
            return;
          }
          resolve();
        });
      });
      const returned = takeReturn();
      if (returned !== undefined) {
        throw new Error(
          `publish to exchange "${returned.exchange}" with routing key "${returned.routingKey}" was unroutable — the topology is incomplete (run \`pnpm rabbitmq:provision\`)`,
        );
      }
      emitHook(hooks, "producer.message_sent", {
        topic: hookTopic,
        ...(hookFamily !== undefined ? { topic_family: hookFamily } : {}),
        bytes: value.length,
        duration_ms: Date.now() - start,
      });
    } catch (err) {
      const error = err as Error;
      emitHook(hooks, "producer.send_failed", {
        topic: hookTopic,
        ...(hookFamily !== undefined ? { topic_family: hookFamily } : {}),
        duration_ms: Date.now() - start,
        error_class: error.name,
        error_message: error.message,
      });
      throw err;
    }
  }

  async function publish(input: PublishInput): Promise<PublishResult> {
    const partitions = partitionsForFamily(config, input.family);
    const partition = partitionForKey(input.partitionKey, partitions);
    const stream = partitionStreamName(input.family, partition);
    await publishConfirmed(
      streamExchangeName(input.family),
      String(partition),
      input.value,
      input.headers,
      input.partitionKey,
      stream,
      input.family,
    );
    return { stream, partition };
  }

  async function publishEvent(input: PublishEventInput): Promise<PublishResult> {
    const family = resolveStreamFamilySync(
      input.family,
      input.event.project_id,
      input.isolation,
    );
    const partitionKey =
      input.partitionKey ??
      buildRawEventsPartitionKey({
        project_id: input.event.project_id,
        environment: input.event.environment,
        event_id: input.event.event_id,
        identity: input.event.identity,
      });

    const headerInput: PolarisHeaderInput = {
      event_id: input.event.event_id,
      event_name: input.event.event,
      schema_version: input.event.schema_version,
      project_id: input.event.project_id,
      environment: input.event.environment,
      occurred_at: input.event.occurred_at,
      ingested_at: input.event.ingested_at,
      source_id: input.event.source?.id,
      producer: producerName,
      producer_version: producerVersion,
      topic_family: input.family,
    };
    const headers = mergeHeaders(buildEventHeaders(headerInput), input.extraHeaders);

    return publish({
      family,
      value: encodeEvent(input.event),
      partitionKey,
      headers,
    });
  }

  async function publishToQueue(input: PublishToQueueInput): Promise<void> {
    const active = await openChannel();
    const start = Date.now();
    try {
      await new Promise<void>((resolve, reject) => {
        const options: Parameters<ConfirmChannel["sendToQueue"]>[2] = {
          persistent: true,
          mandatory: true,
          contentType: "application/json",
          timestamp: Date.now(),
          appId: producerName,
          headers: toAmqpHeaders(input.headers),
        };
        if (input.partitionKey !== undefined && input.partitionKey !== null) {
          options.messageId = input.partitionKey;
        }
        active.sendToQueue(input.queue, input.value, options, (err) => {
          if (err !== null && err !== undefined) {
            reject(err instanceof Error ? err : new Error(String(err)));
            return;
          }
          resolve();
        });
      });
      emitHook(hooks, "producer.message_sent", {
        topic: input.queue,
        bytes: input.value.length,
        duration_ms: Date.now() - start,
      });
    } catch (err) {
      const error = err as Error;
      emitHook(hooks, "producer.send_failed", {
        topic: input.queue,
        duration_ms: Date.now() - start,
        error_class: error.name,
        error_message: error.message,
      });
      throw err;
    }
  }

  return {
    async connect(): Promise<void> {
      closed = false;
      await openChannel();
    },
    async disconnect(): Promise<void> {
      closed = true;
      const current = channel;
      channel = undefined;
      if (current === undefined) return;
      try {
        await current.close();
      } catch {
        // Channel already gone at shutdown is not an error.
      }
      emitHook(hooks, "producer.disconnected", {});
      logger?.info(
        { component: "transport.producer", producer: producerName },
        "producer disconnected",
      );
    },
    publishEvent,
    publish,
    publishToQueue,
  };
}
