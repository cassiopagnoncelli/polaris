/**
 * Metrics and logging hook contracts.
 *
 * The transport driver emits a small fixed set of lifecycle events for
 * producers and consumers. Hosts plug in their own metrics backend (e.g.
 * `prom-client`) and logger by providing handlers — this package does not
 * own a metrics library and stays pure.
 *
 * Hook handlers must be cheap and synchronous. Long-running work should be
 * scheduled out of band.
 */

/**
 * Stable event names emitted by the driver.
 *
 * The Kafka-era `consumer.group_join` / `consumer.group_leave` pair is
 * gone: RabbitMQ consumers take a static partition assignment instead of
 * joining a coordinator-managed group. The replacements report the same
 * operational fact (which consumer owns which partition) without implying
 * a rebalance protocol that no longer exists.
 */
export type TransportHookEvent =
  | "producer.connected"
  | "producer.disconnected"
  | "producer.message_sent"
  | "producer.send_failed"
  | "consumer.connected"
  | "consumer.disconnected"
  | "consumer.message_received"
  | "consumer.message_handled"
  | "consumer.handler_failed"
  | "consumer.partition_assigned"
  | "consumer.partition_released"
  | "consumer.checkpoint_saved"
  | "consumer.rewound";

/**
 * Free-form payload shape attached to a hook event. Field names are
 * intentionally snake_case to match the standard log fields in
 * `08-observability-and-operations.md`.
 *
 * `topic` and `topic_family` keep their Kafka-era names on purpose: they
 * are the Prometheus label keys every Polaris dashboard and alert rule
 * already groups by (`concrete_topic`, `topic_family`). Renaming the label
 * would silently break those queries for zero semantic gain. The values
 * now carry stream names.
 */
export interface TransportHookPayload {
  /** Concrete partition stream (label key `concrete_topic` downstream). */
  readonly topic?: string;
  /** Logical stream family. */
  readonly topic_family?: string;
  readonly partition?: number;
  readonly offset?: string;
  /** Consumer group name — a Polaris-owned checkpoint namespace, not an AMQP concept. */
  readonly group_id?: string;
  readonly client_id?: string;
  readonly project_id?: string;
  readonly environment?: string;
  readonly event_id?: string;
  readonly bytes?: number;
  readonly duration_ms?: number;
  readonly error_class?: string;
  readonly error_message?: string;
  readonly attempt?: number;
}

/**
 * Single handler signature. Hosts may register one or many handlers per
 * event — see `composeHooks` for the multiplexer.
 */
export type TransportHookHandler = (
  event: TransportHookEvent,
  payload: TransportHookPayload,
) => void;

/** Hook surface plugged into the producer/consumer factories. */
export interface TransportHooks {
  /** Called by the driver for every lifecycle event. Optional. */
  readonly onEvent?: TransportHookHandler;
}

/**
 * Build a `TransportHooks` that fans out to multiple handlers. Useful when
 * a service wires both metrics and logging hooks to the same driver.
 */
export function composeHooks(...handlers: ReadonlyArray<TransportHookHandler>): TransportHooks {
  if (handlers.length === 0) {
    return {};
  }
  if (handlers.length === 1) {
    const [only] = handlers;
    if (only === undefined) return {};
    return { onEvent: only };
  }
  return {
    onEvent(event, payload) {
      for (const handler of handlers) {
        try {
          handler(event, payload);
        } catch {
          // Hook errors must never crash the producer/consumer hot path.
          // Hosts that need stricter behavior should wrap their handler.
        }
      }
    },
  };
}

/** Safely invoke an optional hook handler. */
export function emitHook(
  hooks: TransportHooks | undefined,
  event: TransportHookEvent,
  payload: TransportHookPayload,
): void {
  if (hooks === undefined) return;
  if (hooks.onEvent === undefined) return;
  try {
    hooks.onEvent(event, payload);
  } catch {
    // See note on `composeHooks` — hook errors must not propagate.
  }
}
