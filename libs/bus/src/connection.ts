/**
 * RabbitMQ connection supervision.
 *
 * One `TransportConnection` per service process. It owns the AMQP
 * connection, reconnects with backoff, and tells its dependents when a new
 * connection is live so they can re-establish channels.
 *
 * **Why not amqplib's built-in `recovery` option.** amqplib can transparently
 * re-open the connection and replay channel setup, including `basic.consume`.
 * For classic queues that is exactly right. For streams it is a correctness
 * bug: the original `basic.consume` carries an `x-stream-offset` argument, so
 * a replayed consume re-attaches at the offset the process booted with and
 * reprocesses everything since. Polaris re-attaches at the *checkpoint*
 * instead, which only the consumer knows. So the connection is supervised
 * here and consumers re-subscribe themselves.
 *
 * @see docs/architecture/03-rabbitmq-streams.md "Connections and recovery"
 */

import type { RabbitmqConfig } from "@polaris/runtime-config";
import type { Logger } from "@polaris/observability-logger";
import { type Channel, type ChannelModel, type ConfirmChannel, connect } from "amqplib";

/** Reconnect backoff defaults. Mirrors the Kafka-era client retry envelope. */
export const DEFAULT_RECONNECT_OPTIONS: Readonly<ReconnectOptions> = Object.freeze({
  initialDelayMs: 300,
  maxDelayMs: 30_000,
  factor: 2,
  jitter: 0.2,
});

export interface ReconnectOptions {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly factor: number;
  /** Fraction of the delay applied as random jitter (0–1). */
  readonly jitter: number;
}

export interface CreateTransportConnectionOptions {
  /** Typed RabbitMQ config from `@polaris/runtime-config`. */
  readonly rabbitmq: RabbitmqConfig;
  /** Optional logger for connection lifecycle lines. */
  readonly logger?: Logger;
  /** Reconnect backoff overrides, merged over `DEFAULT_RECONNECT_OPTIONS`. */
  readonly reconnect?: Partial<ReconnectOptions>;
  /**
   * Injection seam for tests: replaces `amqplib.connect`. Production leaves
   * it undefined.
   */
  readonly connectFn?: (
    url: string,
    socketOptions: Record<string, unknown>,
  ) => Promise<ChannelModel>;
}

/** Callback invoked every time a fresh connection becomes available. */
export type ReconnectListener = () => void | Promise<void>;

export interface TransportConnection {
  /** Open the connection. Idempotent; concurrent callers share one attempt. */
  connect(): Promise<void>;
  /** Close the connection and stop reconnecting. Idempotent. */
  close(): Promise<void>;
  /** Open a channel on the current connection, connecting first if needed. */
  createChannel(): Promise<Channel>;
  /** Open a publisher-confirm channel. */
  createConfirmChannel(): Promise<ConfirmChannel>;
  /**
   * Register a listener fired after each successful (re)connection —
   * including the first. Returns an unsubscribe handle.
   */
  onReconnected(listener: ReconnectListener): () => void;
  /** True while a live connection is held. */
  readonly connected: boolean;
  /** The config this connection was built from. */
  readonly config: RabbitmqConfig;
}

/**
 * Build the process-wide RabbitMQ connection.
 */
export function createTransportConnection(
  options: CreateTransportConnectionOptions,
): TransportConnection {
  const { rabbitmq, logger } = options;
  const backoff: ReconnectOptions = { ...DEFAULT_RECONNECT_OPTIONS, ...(options.reconnect ?? {}) };
  const connectFn =
    options.connectFn ??
    ((url, socketOptions) => connect(url, socketOptions as Parameters<typeof connect>[1]));

  const listeners = new Set<ReconnectListener>();
  let model: ChannelModel | undefined;
  let pending: Promise<void> | undefined;
  let closed = false;
  let attempt = 0;

  function socketOptions(): Record<string, unknown> {
    const opts: Record<string, unknown> = {
      timeout: rabbitmq.connectionTimeoutMs,
      clientProperties: { connection_name: rabbitmq.clientId },
      heartbeat: rabbitmq.heartbeatSeconds,
    };
    if (rabbitmq.tls) {
      // Verification is on by default in Node's TLS stack; the flag exists
      // so an operator cannot silently end up on a plaintext socket while
      // believing TLS is configured (see the schema's superRefine).
      opts["rejectUnauthorized"] = true;
    }
    return opts;
  }

  async function openOnce(): Promise<void> {
    const next = await connectFn(rabbitmq.url, socketOptions());
    model = next;
    attempt = 0;
    next.on("error", (err: Error) => {
      logger?.warn(
        { component: "transport.connection", err: { name: err.name, message: err.message } },
        "rabbitmq connection error",
      );
    });
    next.on("close", () => {
      model = undefined;
      if (closed) return;
      logger?.warn(
        { component: "transport.connection" },
        "rabbitmq connection closed, reconnecting",
      );
      void scheduleReconnect();
    });
    logger?.info(
      { component: "transport.connection", client_id: rabbitmq.clientId },
      "rabbitmq connected",
    );
    await notify();
  }

  async function notify(): Promise<void> {
    for (const listener of listeners) {
      try {
        await listener();
      } catch (err) {
        const error = err as Error;
        logger?.error(
          {
            component: "transport.connection",
            err: { name: error.name, message: error.message },
          },
          "reconnect listener failed",
        );
      }
    }
  }

  function delayFor(current: number): number {
    const raw = backoff.initialDelayMs * backoff.factor ** current;
    const capped = Math.min(raw, backoff.maxDelayMs);
    const jitter = capped * backoff.jitter * Math.random();
    return Math.round(capped - capped * backoff.jitter + jitter);
  }

  async function scheduleReconnect(): Promise<void> {
    if (closed || model !== undefined) return;
    const wait = delayFor(attempt);
    attempt += 1;
    await sleep(wait);
    if (closed || model !== undefined) return;
    try {
      await openOnce();
    } catch (err) {
      const error = err as Error;
      logger?.warn(
        {
          component: "transport.connection",
          attempt,
          err: { name: error.name, message: error.message },
        },
        "rabbitmq reconnect failed",
      );
      void scheduleReconnect();
    }
  }

  async function doConnect(): Promise<void> {
    if (closed) throw new Error("transport connection: already closed");
    if (model !== undefined) return;
    if (pending !== undefined) return pending;
    pending = openOnce().finally(() => {
      pending = undefined;
    });
    return pending;
  }

  async function requireModel(): Promise<ChannelModel> {
    await doConnect();
    if (model === undefined) {
      throw new Error("transport connection: no live connection");
    }
    return model;
  }

  return {
    connect: doConnect,
    async close(): Promise<void> {
      closed = true;
      const current = model;
      model = undefined;
      if (current === undefined) return;
      try {
        await current.close();
      } catch {
        // A connection that is already gone is not an error at shutdown.
      }
      logger?.info({ component: "transport.connection" }, "rabbitmq disconnected");
    },
    async createChannel(): Promise<Channel> {
      return (await requireModel()).createChannel();
    },
    async createConfirmChannel(): Promise<ConfirmChannel> {
      return (await requireModel()).createConfirmChannel();
    },
    onReconnected(listener: ReconnectListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get connected(): boolean {
      return model !== undefined;
    },
    config: rabbitmq,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
