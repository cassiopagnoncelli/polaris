/**
 * Shared static identity for the webhook-sink v1 consumer.
 *
 * Lives in its own module so both the mapper (which imports it to stamp
 * `delivery.consumer`) and the descriptor (which hands it to the runtime)
 * read the same object without one importing the other. The runtime
 * stamps every `delivery_records` row with these strings.
 */

import type { ConsumerIdentity } from "@polaris/shared-destinations";

export const CONSUMER_VENDOR = "webhook" as const;
/**
 * Queue-topology name for this consumer. Must match the
 * `POLARIS_COMPONENTS` entry that `pnpm rabbitmq:provision` declares —
 * it is what names `webhook-sink.retry.*`, `webhook-sink.redeliver`, and
 * `webhook-sink.dlq`.
 */
export const CONSUMER_COMPONENT = "webhook-sink" as const;
export const CONSUMER_VERSION = "v1" as const;
/**
 * Normalize v2 (WE77L4R8): the normalized event gained `traits`,
 * `traits_version` and `enrichment`, and the identity preference now leads
 * with the platform's resolution — `canonical_customer_id` then
 * `profile_id`, ahead of the producer's `user_id`.
 *
 * Bumped on EVERY consumer, not only the ones reading `resolved.events`,
 * because the version stamps the normalize LOGIC and all six run the same
 * code from this commit forward. A consumer stamping v1 while running v2
 * would put a false claim on every delivery row, which is worse than a
 * stamp that moves without a visible output change: on an
 * `analytics.events` envelope there is no profile block, so the new fields
 * are null and the preference falls straight through to `user_id` exactly
 * as before.
 */
export const NORMALIZE_VERSION = "v2" as const;
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
