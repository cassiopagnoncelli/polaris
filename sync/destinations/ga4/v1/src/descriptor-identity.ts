/**
 * Shared static identity for the ga4 v1 consumer.
 *
 * Lives in its own module so both the mapper (which stamps event-level
 * version metadata for receiver-side audit) and the descriptor (which
 * hands it to the runtime) read the same object without one importing
 * the other. The runtime stamps every `delivery_records` row with these
 * strings.
 *
 * Note: GA4 Measurement Protocol has no numeric API version. The
 * endpoint `https://www.google-analytics.com/mp/collect` is the single
 * server-side ingestion contract; Google evolves it in place. There is
 * no `GA4_API_VERSION` constant because there is nothing to pin.
 */

import type { ConsumerIdentity } from "@polaris/shared-destinations";

export const CONSUMER_VENDOR = "ga4" as const;
/**
 * Queue-topology name for this consumer. Must match the
 * `POLARIS_COMPONENTS` entry that `pnpm rabbitmq:provision` declares —
 * it is what names `ga4.retry.*`, `ga4.redeliver`, and
 * `ga4.dlq`.
 */
export const CONSUMER_COMPONENT = "ga4" as const;
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
