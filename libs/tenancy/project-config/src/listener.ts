/**
 * Invalidation transport.
 *
 * PostgreSQL `LISTEN/NOTIFY` rather than Redis pub/sub, for two reasons. Every
 * Polaris service already holds a Postgres pool while nine of sixteen have no
 * Redis at all, so a Redis bus would add a dependency and a failure mode to
 * most of the fleet purely to carry an invalidation message. And `NOTIFY` is
 * delivered only when its transaction commits, which makes invalidation
 * atomic with the write for free — no publish-after-commit sequencing to get
 * wrong, no window where a rolled-back write has already announced itself.
 *
 * `LISTEN` cannot run on a pooled connection, so the production transport
 * opens a dedicated `pg.Client`. (There is no pgbouncer in the stack;
 * transaction-mode pooling would break this.)
 *
 * @see docs/implementation/project-config-plan.md §4.1
 */

import type { Logger } from "@polaris/observability-logger";
import pg from "pg";

/** Payload carried on {@link CONFIG_NOTIFY_CHANNEL}. */
export interface ConfigChangeMessage {
  readonly project_id: string;
  readonly environment: string;
  readonly version: bigint;
}

export interface ListenerHandlers {
  readonly onMessage: (message: ConfigChangeMessage) => void;
  /**
   * The connection dropped and recovered. Notifications during the gap are
   * lost, so the store drops everything — the only correct recovery.
   */
  readonly onReconnect: () => void;
  readonly onUp: (up: boolean) => void;
}

/**
 * Seam between the store and PostgreSQL's notification channel. Unit tests
 * inject a fake rather than standing up a database.
 */
export interface ListenerTransport {
  start(handlers: ListenerHandlers): Promise<void>;
  close(): Promise<void>;
}

export interface PgListenerTransportOptions {
  readonly connectionString: string;
  readonly channel?: string;
  readonly reconnectMinMs?: number;
  readonly reconnectMaxMs?: number;
  readonly logger: Logger;
}

const DEFAULT_RECONNECT_MIN_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;

/**
 * Parse a `pg_notify` payload.
 *
 * Defensive by design: the payload crosses a trust-ish boundary (any session
 * on the database can `NOTIFY` the channel), and a malformed one must not take
 * the listener down. Returns null rather than throwing; the caller logs and
 * ignores. The sweep would catch the missed change anyway.
 */
export function parseConfigChangeMessage(raw: string | undefined): ConfigChangeMessage | null {
  if (raw === undefined || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const projectId = obj["project_id"];
  const environment = obj["environment"];
  const version = obj["version"];
  if (typeof projectId !== "string" || projectId.length === 0) return null;
  if (typeof environment !== "string" || environment.length === 0) return null;
  if (typeof version !== "number" && typeof version !== "string" && typeof version !== "bigint") {
    return null;
  }
  let asBigInt: bigint;
  try {
    asBigInt = BigInt(version);
  } catch {
    return null;
  }
  return { project_id: projectId, environment, version: asBigInt };
}

/**
 * Production transport: a dedicated `pg.Client` holding `LISTEN` open, with
 * full-jitter exponential backoff on reconnect.
 */
export function createPgListenerTransport(options: PgListenerTransportOptions): ListenerTransport {
  const channel = options.channel ?? "polaris_config_changed";
  const minMs = options.reconnectMinMs ?? DEFAULT_RECONNECT_MIN_MS;
  const maxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;

  let client: pg.Client | undefined;
  let closed = false;
  let attempt = 0;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let hasConnectedOnce = false;

  async function connect(handlers: ListenerHandlers): Promise<void> {
    if (closed) return;
    const next = new pg.Client({ connectionString: options.connectionString });
    next.on("notification", (note) => {
      const message = parseConfigChangeMessage(note.payload);
      if (message === null) {
        options.logger.warn(
          { component: "project-config.listener", channel },
          "ignoring malformed config-change notification",
        );
        return;
      }
      handlers.onMessage(message);
    });
    next.on("error", (err) => {
      options.logger.warn(
        { component: "project-config.listener", err },
        "config listener connection error; scheduling reconnect",
      );
      handlers.onUp(false);
      void teardown(next);
      scheduleReconnect(handlers);
    });

    await next.connect();
    await next.query(`LISTEN ${channel}`);
    client = next;
    attempt = 0;
    handlers.onUp(true);
    // A first connect is not a reconnect: there is nothing cached to drop.
    if (hasConnectedOnce) handlers.onReconnect();
    hasConnectedOnce = true;
  }

  async function teardown(target: pg.Client | undefined): Promise<void> {
    if (target === undefined) return;
    if (client === target) client = undefined;
    try {
      await target.end();
    } catch {
      // Already broken; nothing useful to do.
    }
  }

  function scheduleReconnect(handlers: ListenerHandlers): void {
    if (closed || reconnectTimer !== undefined) return;
    attempt += 1;
    const ceiling = Math.min(maxMs, minMs * 2 ** Math.min(attempt, 16));
    // Full jitter: replicas that dropped together must not retry together.
    const delay = minMs + Math.random() * Math.max(0, ceiling - minMs);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect(handlers).catch(() => {
        scheduleReconnect(handlers);
      });
    }, delay);
    reconnectTimer.unref?.();
  }

  return {
    async start(handlers: ListenerHandlers): Promise<void> {
      closed = false;
      try {
        await connect(handlers);
      } catch (err) {
        // A store must come up even when the listener cannot: the sweep still
        // provides freshness, just at its own interval.
        options.logger.warn(
          { component: "project-config.listener", err },
          "config listener failed to start; retrying in background",
        );
        handlers.onUp(false);
        scheduleReconnect(handlers);
      }
    },
    async close(): Promise<void> {
      closed = true;
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      await teardown(client);
    },
  };
}
