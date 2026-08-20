/**
 * webhook-sink v1 host.
 *
 * Config and descriptor. Everything else — Postgres, the AMQP connection,
 * checkpoints, the DLQ producer, the instance cache, the project-config
 * store, the Redis-backed dedupe and rate limiter, shutdown ordering and the
 * Fastify shell — is `@polaris/delivery-host`.
 *
 * This consumer is the reason the host takes its component from the
 * descriptor identity rather than from a vendor string. Its vendor is
 * `webhook` while its topology component is `webhook-sink`, and the two
 * being different is what made it ask the broker for queues nobody had
 * declared — a bug the other four consumers could not have, and therefore
 * one that four copies of the same bootstrap would never surface.
 */

import {
  type BuiltDestinationHost,
  buildDestinationHost,
  type DestinationHostOverrides,
} from "@polaris/delivery-host";
import {
  STREAM_FAMILY_PROFILE_EVENTS,
  STREAM_FAMILY_RESOLVED_EVENTS,
} from "@polaris/bus";

import type { WebhookSinkRuntimeConfig } from "./config.js";
import { createWebhookSinkDescriptor } from "./descriptor.js";
import { PROJECT_CONFIG_NAMESPACE } from "./project-config.js";
import type { WebhookPayload } from "./types.js";

export interface BuildAppOptions extends DestinationHostOverrides<WebhookPayload> {
  readonly config: WebhookSinkRuntimeConfig;
  /** Vendor HTTP client, injected by tests. */
  readonly fetch?: typeof globalThis.fetch;
}

export type BuiltWebhookSinkApp = BuiltDestinationHost;

export async function buildWebhookSinkApp(options: BuildAppOptions): Promise<BuiltWebhookSinkApp> {
  const { config, fetch, ...overrides } = options;
  return buildDestinationHost({
    config,
    descriptor: createWebhookSinkDescriptor({
      requestTimeoutMs: config.sink.requestTimeoutMs,
      ...(fetch !== undefined ? { fetch } : {}),
      ...(overrides.now !== undefined ? { now: overrides.now } : {}),
    }),
    projectConfigNamespace: PROJECT_CONFIG_NAMESPACE,
    // WE77L4R8: the transparency exemplar reads the spine's output, so a
    // receiver pointed here sees exactly what a vendor mapper sees.
    //
    // Two families, for the same reason Braze reads two: the spine carries
    // what customers DID, the profile plane carries what is now TRUE of
    // them — audience membership and journey steps. An exemplar that showed
    // only half of what a destination receives would be a poor exemplar,
    // and journeys would have no destination to demonstrate against.
    inputFamily: [STREAM_FAMILY_RESOLVED_EVENTS, STREAM_FAMILY_PROFILE_EVENTS],
    allowReplay: config.sink.allowReplay,
    consumerGroup: config.sink.consumerGroup,
    description:
      "Destination consumer that POSTs canonical events to an operator-configured HTTPS receiver. /health, /ready, and /metrics only — no business routes.",
    overrides,
  });
}
