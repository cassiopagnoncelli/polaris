/**
 * Structured logging for the transport's lifecycle events.
 *
 * `TransportHooks` has existed for as long as the transport has, with eleven
 * events and one implementation detail that made all of them moot: no service
 * ever passed a `hooks` object. `consumer.poisoned`, `consumer.rewound`,
 * `consumer.partition_assigned` and the rest were emitted into `undefined`.
 *
 * That is why a rewind storm, a dead-lettered message, and a partition that
 * was never assigned all looked the same from outside the process — the
 * consumer logs its own errors, but the lifecycle events that explain WHY it
 * is behaving as it does went nowhere.
 *
 * ## Levels
 *
 * The level is the point of this module, not decoration. Per-message events
 * (`message_received`, `message_handled`) are `trace`: at any real throughput
 * they would drown the log, and their aggregate lives in metrics. Lifecycle
 * transitions are `info` because an operator reading a startup or shutdown
 * wants them. `rewound` is `warn` — the consumer is redoing work. `poisoned`
 * and `checkpoint_failed` are `error`: a message was abandoned, or a healthy
 * message's position was lost, and both need someone.
 */

import type { Logger } from "@polaris/shared-logger";
import type { TransportHookEvent, TransportHookPayload, TransportHooks } from "./hooks.js";

type Level = "trace" | "info" | "warn" | "error";

/**
 * How loudly each event is reported.
 *
 * An event missing from this map is logged at `info`, so a hook added later
 * is visible by default rather than silently dropped — which is the failure
 * this whole module exists to correct.
 */
const LEVELS: Readonly<Partial<Record<TransportHookEvent, Level>>> = {
  "consumer.message_received": "trace",
  "consumer.message_handled": "trace",
  "producer.message_sent": "trace",
  "consumer.checkpoint_saved": "trace",
  "consumer.handler_failed": "warn",
  "consumer.rewound": "warn",
  "producer.send_failed": "error",
  "consumer.poisoned": "error",
  "consumer.checkpoint_failed": "error",
};

export interface CreateTransportLogHooksInput {
  readonly logger: Logger;
  /** Component name stamped on every line, e.g. `sessionizer`. */
  readonly component?: string;
}

/** Build hooks that write every transport lifecycle event to the log. */
export function createTransportLogHooks(input: CreateTransportLogHooksInput): TransportHooks {
  const component = input.component ?? "transport";
  return {
    onEvent(event: TransportHookEvent, payload: TransportHookPayload): void {
      const level = LEVELS[event] ?? "info";
      input.logger[level]({ component: `${component}.transport`, event, ...payload }, event);
    },
  };
}
