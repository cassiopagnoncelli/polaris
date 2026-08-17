/**
 * braze v1 host.
 *
 * Config and descriptor. Everything else — Postgres, the AMQP connection,
 * checkpoints, the DLQ producer, the instance cache, the project-config
 * store, the Redis-backed dedupe and rate limiter, shutdown ordering and the
 * Fastify shell — is `@polaris/destination-host`.
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
} from "@polaris/destination-host";
import {
  STREAM_FAMILY_PROFILE_EVENTS,
  STREAM_FAMILY_RESOLVED_EVENTS,
} from "@polaris/shared-transport";

import type { BrazeRuntimeConfig } from "./config.js";
import { createBrazeDescriptor } from "./descriptor.js";
import { PROJECT_CONFIG_NAMESPACE } from "./project-config.js";
import type { BrazePayload } from "./types.js";

export interface BuildAppOptions extends DestinationHostOverrides<BrazePayload> {
  readonly config: BrazeRuntimeConfig;
  /** Vendor HTTP client, injected by tests. */
  readonly fetch?: typeof globalThis.fetch;
}

export type BuiltBrazeApp = BuiltDestinationHost;

export async function buildBrazeApp(options: BuildAppOptions): Promise<BuiltBrazeApp> {
  const { config, fetch, ...overrides } = options;
  return buildDestinationHost({
    config,
    descriptor: createBrazeDescriptor({
      requestTimeoutMs: config.braze.requestTimeoutMs,
      apiHost: config.braze.apiHost,
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    }),
    projectConfigNamespace: PROJECT_CONFIG_NAMESPACE,
    // MVKUP64R: reads the spine's output, so the profile and enrichment
    // blocks the identity and enrichment stages wrote reach this mapper.
    // Two families. The spine carries what customers DID; the profile
    // plane carries what is now TRUE of them, and audience membership is
    // the second kind. Before this, `audience.entered` was published,
    // stored, and read by no vendor — the profile plane was a warehouse
    // feature wearing an activation feature's name.
    inputFamily: [STREAM_FAMILY_RESOLVED_EVENTS, STREAM_FAMILY_PROFILE_EVENTS],
    allowReplay: config.braze.allowReplay,
    consumerGroup: config.braze.consumerGroup,
    description:
      "Destination consumer that POSTs canonical events into Braze's REST API. /health, /ready, and /metrics only — no business routes.",
    overrides,
  });
}
