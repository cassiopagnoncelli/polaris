/**
 * Metrics and logging hook contracts.
 *
 * The KafkaJS wrapper emits a small fixed set of lifecycle events for
 * producers and consumers. Hosts plug in their own metrics backend (e.g.
 * `prom-client`) and logger by providing handlers — this package does not
 * own a metrics library and stays pure.
 *
 * Hook handlers must be cheap and synchronous. Long-running work should be
 * scheduled out of band.
 */

/** Stable event names emitted by the wrapper. */
export type KafkaHookEvent =
  | "producer.connected"
  | "producer.disconnected"
  | "producer.message_sent"
  | "producer.send_failed"
  | "consumer.connected"
  | "consumer.disconnected"
  | "consumer.message_received"
  | "consumer.message_handled"
  | "consumer.handler_failed"
  | "consumer.group_join"
  | "consumer.group_leave";

/**
 * Free-form payload shape attached to a hook event. Field names are
 * intentionally snake_case to match the standard log fields in
 * `08-observability-and-operations.md`.
 */
export interface KafkaHookPayload {
  readonly topic?: string;
  readonly topic_family?: string;
  readonly partition?: number;
  readonly offset?: string;
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
export type KafkaHookHandler = (event: KafkaHookEvent, payload: KafkaHookPayload) => void;

/** Hook surface plugged into the producer/consumer factories. */
export interface KafkaHooks {
  /** Called by the wrapper for every lifecycle event. Optional. */
  readonly onEvent?: KafkaHookHandler;
}

/**
 * Build a `KafkaHooks` that fans out to multiple handlers. Useful when a
 * service wires both metrics and logging hooks to the same wrapper.
 */
export function composeHooks(...handlers: ReadonlyArray<KafkaHookHandler>): KafkaHooks {
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
  hooks: KafkaHooks | undefined,
  event: KafkaHookEvent,
  payload: KafkaHookPayload,
): void {
  if (hooks === undefined) return;
  if (hooks.onEvent === undefined) return;
  try {
    hooks.onEvent(event, payload);
  } catch {
    // See note on `composeHooks` — hook errors must not propagate.
  }
}
