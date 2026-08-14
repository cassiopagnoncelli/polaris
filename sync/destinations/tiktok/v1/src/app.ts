/**
 * tiktok v1 host.
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

import type { TikTokRuntimeConfig } from "./config.js";
import { createTikTokDescriptor } from "./descriptor.js";
import { PROJECT_CONFIG_NAMESPACE } from "./project-config.js";
import type { TikTokEventPayload } from "./types.js";

export interface BuildAppOptions extends DestinationHostOverrides<TikTokEventPayload> {
  readonly config: TikTokRuntimeConfig;
  /** Vendor HTTP client, injected by tests. */
  readonly fetch?: typeof globalThis.fetch;
}

export type BuiltTikTokApp = BuiltDestinationHost;

export async function buildTikTokApp(options: BuildAppOptions): Promise<BuiltTikTokApp> {
  const { config, fetch, ...overrides } = options;
  return buildDestinationHost({
    config,
    descriptor: createTikTokDescriptor({
      requestTimeoutMs: config.tiktok.requestTimeoutMs,
      apiHost: config.tiktok.apiHost,
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    }),
    projectConfigNamespace: PROJECT_CONFIG_NAMESPACE,
    // MVKUP64R: reads the spine's output, so the profile and enrichment
    // blocks the identity and enrichment stages wrote reach this mapper.
    inputFamily: STREAM_FAMILY_RESOLVED_EVENTS,
    allowReplay: config.tiktok.allowReplay,
    consumerGroup: config.tiktok.consumerGroup,
    description:
      "Destination consumer that POSTs canonical events into TikTok's Events API. /health, /ready, and /metrics only — no business routes.",
    overrides,
  });
}
