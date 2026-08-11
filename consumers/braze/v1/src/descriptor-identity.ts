/**
 * Shared static identity for the braze v1 consumer.
 *
 * Lives in its own module so both the mapper (which stamps event-level
 * version metadata for receiver-side audit) and the descriptor (which
 * hands it to the runtime) read the same object without one importing
 * the other. The runtime stamps every `delivery_records` row with these
 * strings.
 *
 * Unlike Meta CAPI or TikTok, Braze's REST API is not versioned through
 * a path segment — the `/users/track` endpoint is the canonical surface
 * the vendor publishes without a discrete `vN.M` literal. The manifest
 * records `vendor_api_version: rest` to signal "the REST contract at the
 * time this consumer shipped"; a future v2 of this consumer would bump
 * if Braze breaks the contract semantically.
 */

import type { ConsumerIdentity } from "@polaris/shared-destinations";

export const CONSUMER_VENDOR = "braze" as const;
/**
 * Queue-topology name for this consumer. Must match the
 * `POLARIS_COMPONENTS` entry that `pnpm rabbitmq:provision` declares —
 * it is what names `braze.retry.*`, `braze.redeliver`, and
 * `braze.dlq`.
 */
export const CONSUMER_COMPONENT = "braze" as const;
export const CONSUMER_VERSION = "v1" as const;
export const NORMALIZE_VERSION = "v1" as const;
export const MAPPER_VERSION = "v1" as const;
export const DELIVERER_VERSION = "v1" as const;

export const CONSUMER_IDENTITY: ConsumerIdentity = {
  vendor: CONSUMER_VENDOR,
  component: CONSUMER_COMPONENT,
  consumerVersion: CONSUMER_VERSION,
  normalizeVersion: NORMALIZE_VERSION,
  mapperVersion: MAPPER_VERSION,
  delivererVersion: DELIVERER_VERSION,
};
