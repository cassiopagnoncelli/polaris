/**
 * Shared static identity for the meta-capi v1 consumer.
 *
 * Lives in its own module so both the mapper (which stamps event-level
 * version metadata for receiver-side audit) and the descriptor (which
 * hands it to the runtime) read the same object without one importing
 * the other. The runtime stamps every `delivery_records` row with these
 * strings.
 */

import type { ConsumerIdentity } from "@polaris/shared-destinations";

export const CONSUMER_VENDOR = "meta-capi" as const;
export const CONSUMER_VERSION = "v1" as const;
export const NORMALIZE_VERSION = "v1" as const;
export const MAPPER_VERSION = "v1" as const;
export const DELIVERER_VERSION = "v1" as const;

/** Meta Graph API version this consumer targets. Pinned for v1. */
export const META_GRAPH_API_VERSION = "v22.0" as const;

export const CONSUMER_IDENTITY: ConsumerIdentity = {
  vendor: CONSUMER_VENDOR,
  consumerVersion: CONSUMER_VERSION,
  normalizeVersion: NORMALIZE_VERSION,
  mapperVersion: MAPPER_VERSION,
  delivererVersion: DELIVERER_VERSION,
};
