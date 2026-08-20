/**
 * ga4 v1 host.
 *
 * Config and descriptor. Everything else — Postgres, the AMQP connection,
 * checkpoints, the DLQ producer, the instance cache, the project-config
 * store, the Redis-backed dedupe and rate limiter, shutdown ordering and the
 * Fastify shell — is `@polaris/delivery-host`.
 *
 * This file was ~413 lines and differed from the other four consumers by
 * about a dozen after substituting the vendor name. Those were not twelve
 * intentional differences; they were the places a platform fix had been
 * applied four times and missed once.
 */

import {
  type BuiltDestinationHost,
  buildDestinationHost,
  type DestinationHostOverrides,
} from "@polaris/delivery-host";
import { STREAM_FAMILY_RESOLVED_EVENTS } from "@polaris/bus";

import type { Ga4RuntimeConfig } from "./config.js";
import { createGa4Descriptor } from "./descriptor.js";
import { PROJECT_CONFIG_NAMESPACE } from "./project-config.js";
import type { Ga4EventPayload } from "./types.js";

export interface BuildAppOptions extends DestinationHostOverrides<Ga4EventPayload> {
  readonly config: Ga4RuntimeConfig;
  /** Vendor HTTP client, injected by tests. */
  readonly fetch?: typeof globalThis.fetch;
}

export type BuiltGa4App = BuiltDestinationHost;

export async function buildGa4App(options: BuildAppOptions): Promise<BuiltGa4App> {
  const { config, fetch, ...overrides } = options;
  return buildDestinationHost({
    config,
    descriptor: createGa4Descriptor({
      requestTimeoutMs: config.ga4.requestTimeoutMs,
      apiHost: config.ga4.apiHost,
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    }),
    projectConfigNamespace: PROJECT_CONFIG_NAMESPACE,
    // MVKUP64R: reads the spine's output, so the profile and enrichment
    // blocks the identity and enrichment stages wrote reach this mapper.
    inputFamily: STREAM_FAMILY_RESOLVED_EVENTS,
    allowReplay: config.ga4.allowReplay,
    consumerGroup: config.ga4.consumerGroup,
    description:
      "Destination consumer that POSTs canonical events into GA4's Measurement Protocol. /health, /ready, and /metrics only — no business routes.",
    overrides,
  });
}
