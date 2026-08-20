/**
 * In-memory doubles for the amqplib surface the driver actually uses.
 *
 * These are deliberately hand-written rather than mocked: the tests that
 * matter here assert *exact* AMQP arguments (queue types, TTLs,
 * `x-stream-offset` shapes, routing keys), and a mock that accepts
 * anything would pass while the real broker rejected the declaration.
 */

import type { RabbitmqConfig } from "@polaris/runtime-config";
import type { Channel, ConfirmChannel, ConsumeMessage } from "amqplib";
import type { TransportConnection } from "../src/connection.js";

export interface RecordedQueue {
  readonly queue: string;
  readonly options: Record<string, unknown>;
}

export interface RecordedExchange {
  readonly exchange: string;
  readonly type: string;
  readonly options: Record<string, unknown>;
}

export interface RecordedBinding {
  readonly queue: string;
  readonly exchange: string;
  readonly pattern: string;
}

export interface RecordedPublish {
  readonly exchange: string;
  readonly routingKey: string;
  readonly content: Buffer;
  readonly options: Record<string, unknown>;
}

export interface RecordedConsume {
  readonly queue: string;
  readonly options: Record<string, unknown>;
}

/** A channel that records everything and can push deliveries back. */
export class FakeChannel {
  readonly queues: RecordedQueue[] = [];
  readonly exchanges: RecordedExchange[] = [];
  readonly bindings: RecordedBinding[] = [];
  readonly publishes: RecordedPublish[] = [];
  readonly consumes: RecordedConsume[] = [];
  readonly acked: ConsumeMessage[] = [];
  readonly nacked: { message: ConsumeMessage; requeue: boolean }[] = [];
  prefetchCount: number | undefined;
  closed = false;
  cancelled: string[] = [];
  /** Set when the caller should be told a publish was unroutable. */
  returnOnPublish = false;
  /**
   * Hold confirms instead of resolving them inline, so a test can
   * interleave two concurrent publishes. Resolve them with
   * `releaseConfirm(index)`.
   */
  deferConfirms = false;
  /** Publish indexes whose broker return should fire (unroutable). */
  returnAt = new Set<number>();
  /** Fail the Nth publish (0-based) with this error. */
  failPublishAt: number | undefined;

  #handlers = new Map<string, (msg: ConsumeMessage | null) => void>();
  #listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  #tag = 0;

  on(event: string, listener: (...args: unknown[]) => void): this {
    const existing = this.#listeners.get(event) ?? [];
    existing.push(listener);
    this.#listeners.set(event, existing);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(...args);
  }

  async assertExchange(
    exchange: string,
    type: string,
    options: Record<string, unknown>,
  ): Promise<{ exchange: string }> {
    this.exchanges.push({ exchange, type, options });
    return { exchange };
  }

  async assertQueue(
    queue: string,
    options: Record<string, unknown>,
  ): Promise<{ queue: string; messageCount: number; consumerCount: number }> {
    this.queues.push({ queue, options });
    return { queue, messageCount: 0, consumerCount: 0 };
  }

  async bindQueue(queue: string, exchange: string, pattern: string): Promise<object> {
    this.bindings.push({ queue, exchange, pattern });
    return {};
  }

  async prefetch(count: number): Promise<object> {
    this.prefetchCount = count;
    return {};
  }

  #pendingConfirms = new Map<number, (err: unknown, ok: object) => void>();

  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: Record<string, unknown>,
    callback?: (err: unknown, ok: object) => void,
  ): boolean {
    const index = this.publishes.length;
    this.publishes.push({ exchange, routingKey, content, options });
    if (this.returnOnPublish || this.returnAt.has(index)) {
      // A real broker returns the whole message, properties included —
      // that is what lets a publisher tell WHICH publish came back.
      this.emit("return", { fields: { exchange, routingKey }, properties: { ...options } });
    }
    if (this.failPublishAt === index) {
      callback?.(new Error("nacked by broker"), {});
      return true;
    }
    if (this.deferConfirms) {
      if (callback !== undefined) this.#pendingConfirms.set(index, callback);
      return true;
    }
    callback?.(null, {});
    return true;
  }

  /** Resolve a deferred confirm by publish index. */
  releaseConfirm(index: number, err: unknown = null): void {
    const callback = this.#pendingConfirms.get(index);
    if (callback === undefined) throw new Error(`no pending confirm at index ${String(index)}`);
    this.#pendingConfirms.delete(index);
    callback(err, {});
  }

  /** Fire a broker return for an already-issued publish, by index. */
  returnPublish(index: number): void {
    const publish = this.publishes[index];
    if (publish === undefined) throw new Error(`no publish at index ${String(index)}`);
    this.emit("return", {
      fields: { exchange: publish.exchange, routingKey: publish.routingKey },
      properties: { ...publish.options },
    });
  }

  sendToQueue(
    queue: string,
    content: Buffer,
    options: Record<string, unknown>,
    callback?: (err: unknown, ok: object) => void,
  ): boolean {
    this.publishes.push({ exchange: "", routingKey: queue, content, options });
    callback?.(null, {});
    return true;
  }

  async consume(
    queue: string,
    onMessage: (msg: ConsumeMessage | null) => void,
    options: Record<string, unknown>,
  ): Promise<{ consumerTag: string }> {
    this.consumes.push({ queue, options });
    this.#tag += 1;
    const tag = `tag-${this.#tag}`;
    this.#handlers.set(tag, onMessage);
    return { consumerTag: tag };
  }

  async cancel(consumerTag: string): Promise<object> {
    this.cancelled.push(consumerTag);
    this.#handlers.delete(consumerTag);
    return {};
  }

  ack(message: ConsumeMessage): void {
    this.acked.push(message);
  }

  nack(message: ConsumeMessage, _allUpTo: boolean, requeue: boolean): void {
    this.nacked.push({ message, requeue });
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** Push a delivery into every active consumer on this channel. */
  deliver(message: ConsumeMessage): void {
    for (const handler of this.#handlers.values()) handler(message);
  }

  asChannel(): Channel {
    return this as unknown as Channel;
  }

  asConfirmChannel(): ConfirmChannel {
    return this as unknown as ConfirmChannel;
  }
}

/** Build a delivery that looks like what RabbitMQ hands back for a stream. */
export function streamDelivery(input: {
  offset: number;
  headers?: Record<string, unknown>;
  body?: string;
  messageId?: string;
  timestamp?: number;
  deliveryTag?: number;
  redelivered?: boolean;
}): ConsumeMessage {
  return {
    content: Buffer.from(input.body ?? "{}", "utf8"),
    fields: {
      deliveryTag: input.deliveryTag ?? input.offset + 1,
      redelivered: input.redelivered ?? false,
      exchange: "",
      routingKey: "",
      consumerTag: "tag-1",
    },
    properties: {
      contentType: "application/json",
      contentEncoding: undefined,
      headers: { "x-stream-offset": input.offset, ...(input.headers ?? {}) },
      deliveryMode: 2,
      priority: undefined,
      correlationId: undefined,
      replyTo: undefined,
      expiration: undefined,
      messageId: input.messageId,
      timestamp: input.timestamp ?? 1_760_000_000_000,
      type: undefined,
      userId: undefined,
      appId: "test",
      clusterId: undefined,
    },
  } as unknown as ConsumeMessage;
}

export const testRabbitmqConfig: RabbitmqConfig = {
  url: "amqp://polaris:polaris@localhost:5672/%2F",
  managementUrl: undefined,
  clientId: "test-client",
  tls: false,
  heartbeatSeconds: 30,
  connectionTimeoutMs: 10_000,
  partitions: 3,
  partitionOverrides: {},
  assignedPartitions: [],
  prefetch: 10,
  checkpointIntervalMs: 5_000,
  checkpointEvery: 500,
  streamRetentionDays: 90,
};

/** A connection that hands out `FakeChannel`s and can fire reconnects. */
export class FakeConnection {
  readonly channels: FakeChannel[] = [];
  connected = true;
  closedCount = 0;
  readonly #listeners: Array<() => void | Promise<void>> = [];

  constructor(readonly config: RabbitmqConfig = testRabbitmqConfig) {}

  async connect(): Promise<void> {
    this.connected = true;
  }

  async close(): Promise<void> {
    this.connected = false;
    this.closedCount += 1;
  }

  async createChannel(): Promise<Channel> {
    const channel = new FakeChannel();
    this.channels.push(channel);
    return channel.asChannel();
  }

  async createConfirmChannel(): Promise<ConfirmChannel> {
    const channel = new FakeChannel();
    this.channels.push(channel);
    return channel.asConfirmChannel();
  }

  onReconnected(listener: () => void | Promise<void>): () => void {
    this.#listeners.push(listener);
    return () => undefined;
  }

  /** Simulate a reconnect: every registered listener re-establishes. */
  async fireReconnect(): Promise<void> {
    for (const listener of this.#listeners) await listener();
  }

  /** The most recently created channel. */
  get last(): FakeChannel {
    const channel = this.channels.at(-1);
    if (channel === undefined) throw new Error("no channel created yet");
    return channel;
  }

  asConnection(): TransportConnection {
    return this as unknown as TransportConnection;
  }
}
