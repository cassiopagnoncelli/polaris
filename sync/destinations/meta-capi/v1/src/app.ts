/**
 * meta-capi v1 host.
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
import { STREAM_FAMILY_RESOLVED_EVENTS } from "@polaris/shared-transport";

import type { MetaCapiRuntimeConfig } from "./config.js";
import { createMetaCapiDescriptor } from "./descriptor.js";
import { PROJECT_CONFIG_NAMESPACE } from "./project-config.js";
import type { MetaCapiPayload } from "./types.js";

export interface BuildAppOptions extends DestinationHostOverrides<MetaCapiPayload> {
  readonly config: MetaCapiRuntimeConfig;
  /** Vendor HTTP client, injected by tests. */
  readonly fetch?: typeof globalThis.fetch;
}

export type BuiltMetaCapiApp = BuiltDestinationHost;

export async function buildMetaCapiApp(options: BuildAppOptions): Promise<BuiltMetaCapiApp> {
  const { config, fetch, ...overrides } = options;
  return buildDestinationHost({
    config,
    descriptor: createMetaCapiDescriptor({
      requestTimeoutMs: config.meta.requestTimeoutMs,
      graphHost: config.meta.graphHost,
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    }),
    projectConfigNamespace: PROJECT_CONFIG_NAMESPACE,
    // MVKUP64R: reads the spine's output, so the profile and enrichment
    // blocks the identity and enrichment stages wrote reach this mapper.
    inputFamily: STREAM_FAMILY_RESOLVED_EVENTS,
    allowReplay: config.meta.allowReplay,
    consumerGroup: config.meta.consumerGroup,
    description:
      "Destination consumer that POSTs canonical events into Meta's Conversions API. /health, /ready, and /metrics only — no business routes.",
    overrides,
  });
}
