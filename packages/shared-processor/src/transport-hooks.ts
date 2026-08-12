/**
 * Transport lifecycle events, wired to a processor's logs AND its metrics.
 *
 * Two dead mechanisms meet here. `TransportHooks` was passed by no service, so
 * eleven lifecycle events were emitted into nothing. And `ProcessorMetrics`
 * has `incrementDlq` and `incrementRetry` with zero production call sites, so
 * `polaris_processor_events_dlq_total` and `..._retry_total` have never been
 * written — while the `polaris-processors` dashboard plots both and the DLQ
 * growth alert rule sums one of them.
 *
 * They are the same gap seen from two ends: the transport knew a message was
 * dead-lettered or a partition rewound, and the metric that reports it had
 * nobody to call it. Composing them here is the whole fix.
 *
 * ## What maps to what
 *
 *   - `consumer.poisoned`  -> `incrementDlq`. A message was abandoned to the
 *     DLQ; this is the counter the growth alert watches.
 *   - `consumer.rewound`   -> `incrementRetry`. The consumer re-reads from the
 *     checkpoint, so every message after it is redelivered — which IS the
 *     platform's retry mechanism, not an approximation of one.
 *
 * `consumer.handler_failed` is deliberately NOT counted here: the runtimes
 * already call `incrementFailed` with a classified reason, and counting it
 * twice would double every failure on the dashboard.
 */

import type { Logger } from "@polaris/shared-logger";
import {
  composeHooks,
  createTransportLogHooks,
  type TransportHookEvent,
  type TransportHookPayload,
  type TransportHooks,
} from "@polaris/shared-transport";

import type { ProcessorIdentity } from "./identity.js";
import type { ProcessorMetrics } from "./metrics.js";

export interface CreateProcessorTransportHooksInput {
  readonly logger: Logger;
  readonly metrics: ProcessorMetrics;
  readonly identity: ProcessorIdentity;
}

/**
 * Build the hooks every processor passes to its consumer and producer.
 *
 * Logging and metrics are composed rather than chosen: an operator reading a
 * log line and an operator reading a dashboard are looking for the same
 * incident, and making one of them optional is how the other becomes the only
 * one anybody wires.
 */
export function createProcessorTransportHooks(
  input: CreateProcessorTransportHooksInput,
): TransportHooks {
  const log = createTransportLogHooks({ logger: input.logger, component: input.identity.name });

  const meter = (event: TransportHookEvent, payload: TransportHookPayload): void => {
    const labels = {
      processor_name: input.identity.name,
      processor_version: input.identity.version,
      ...(payload.topic_family !== undefined ? { topic_family: payload.topic_family } : {}),
      ...(payload.project_id !== undefined ? { project_id: payload.project_id } : {}),
      ...(payload.environment !== undefined ? { environment: payload.environment } : {}),
    };
    if (event === "consumer.poisoned") {
      input.metrics.incrementDlq({ ...labels, reason: "poison_message" });
      return;
    }
    if (event === "consumer.rewound") {
      input.metrics.incrementRetry({ ...labels, reason: "rewound" });
    }
  };

  return composeHooks(log.onEvent as NonNullable<TransportHooks["onEvent"]>, meter);
}
