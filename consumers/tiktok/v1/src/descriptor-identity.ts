/**
 * Shared static identity for the tiktok v1 consumer.
 *
 * Lives in its own module so both the mapper (which stamps event-level
 * version metadata for receiver-side audit) and the descriptor (which
 * hands it to the runtime) read the same object without one importing
 * the other. The runtime stamps every `delivery_records` row with these
 * strings.
 */

import type { ConsumerIdentity } from "@polaris/shared-destinations";

export const CONSUMER_VENDOR = "tiktok" as const;
export const CONSUMER_VERSION = "v1" as const;
export const NORMALIZE_VERSION = "v1" as const;
export const MAPPER_VERSION = "v1" as const;
export const DELIVERER_VERSION = "v1" as const;

/**
 * TikTok Events API version this consumer targets. Pinned for v1.
 *
 * TikTok publishes the Events API under their Marketing API namespace at
 * `business-api.tiktok.com/open_api/<version>/event/track/`. `v1.3` is
 * the current GA Events API version as of the v1 release; bumping
 * across vendor breaking changes requires a v2 of this consumer.
 */
export const TIKTOK_EVENTS_API_VERSION = "v1.3" as const;

export const CONSUMER_IDENTITY: ConsumerIdentity = {
  vendor: CONSUMER_VENDOR,
  consumerVersion: CONSUMER_VERSION,
  normalizeVersion: NORMALIZE_VERSION,
  mapperVersion: MAPPER_VERSION,
  delivererVersion: DELIVERER_VERSION,
};
