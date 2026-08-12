/**
 * Transport lifecycle events, wired to a destination's logs and its metrics.
 *
 * `TransportHooks` was passed by no service, so eleven lifecycle events were
 * emitted into nothing — a rewind storm, a dead-lettered message, and a
 * partition that was never assigned all looked identical from outside the
 * process.
 *
 * ## What is counted here, and what deliberately is not
 *
 *   - `consumer.rewound` -> `incrementRetry`. The consumer re-reads from its
 *     checkpoint, so every message after that point is redelivered — which IS
 *     the platform's retry mechanism, not an approximation of one. Nothing
 *     else in `@polaris/shared-destinations` calls `incrementRetry`, so
 *     `polaris_destination_events_retry_total` was a metric that existed and
 *     was never written.
 *
 *   - `consumer.poisoned` is NOT counted, unlike the processor equivalent.
 *     {@link createDestinationRuntime} already calls `incrementDlq` on both of
 *     its dead-letter paths, so counting the transport's poison event as well
 *     would double every DLQ entry on the dashboard — and the DLQ growth alert
 *     rule sums that series.
 *
 * Everything reaches the log regardless; only the metric side is selective.
 */

import type { Logger } from "@polaris/shared-logger";
import {
  composeHooks,
  createTransportLogHooks,
  type TransportHookEvent,
  type TransportHookPayload,
  type TransportHooks,
} from "@polaris/shared-transport";

import type { DestinationMetrics } from "./metrics.js";

export interface CreateDestinationTransportHooksInput {
  readonly logger: Logger;
  readonly metrics: DestinationMetrics;
  /** Vendor slug, e.g. `braze`. Stamped on log lines and metric labels. */
  readonly vendor: string;
  /** Consumer version, e.g. `v1`. */
  readonly consumerVersion: string;
}

/** Build the hooks a destination passes to its consumer and producer. */
export function createDestinationTransportHooks(
  input: CreateDestinationTransportHooksInput,
): TransportHooks {
  const log = createTransportLogHooks({ logger: input.logger, component: input.vendor });

  const meter = (event: TransportHookEvent, payload: TransportHookPayload): void => {
    if (event !== "consumer.rewound") return;
    input.metrics.incrementRetry({
      vendor: input.vendor,
      consumer_version: input.consumerVersion,
      reason: "rewound",
      ...(payload.topic_family !== undefined ? { topic_family: payload.topic_family } : {}),
      ...(payload.project_id !== undefined ? { project_id: payload.project_id } : {}),
      ...(payload.environment !== undefined ? { environment: payload.environment } : {}),
      ...(payload.partition !== undefined ? { partition: payload.partition } : {}),
    });
  };

  return composeHooks(log.onEvent as NonNullable<TransportHooks["onEvent"]>, meter);
}
