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

import type { ConsumerIdentity } from "@polaris/delivery-destinations";

export const CONSUMER_VENDOR = "ga4" as const;
/**
 * Queue-topology name for this consumer. Must match the
 * `POLARIS_COMPONENTS` entry that `pnpm rabbitmq:provision` declares —
 * it is what names `ga4.retry.*`, `ga4.redeliver`, and
 * `ga4.dlq`.
 */
export const CONSUMER_COMPONENT = "ga4" as const;
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
 *
 * Normalize v3 (1VEL3): identity preparation falls back to the
 * profile-trait snapshot, and the hashed set widens from email and phone
 * to the eight further keys the ad platforms match on. Unlike v2 this one
 * has a visible output change on every consumer that hashes — enrichment
 * stamps `traits.email` on every resolved event of a known person, and
 * the slot the mappers emit `em` / `ph` from was null until it was read.
 *
 * Bumped on every consumer for v2's reason, and for a second one that v2
 * did not have: the delivery key is
 * `SHA-256(destination_id|event_id|normalize_version|...)`, so a stamp
 * that does not move makes a replay of an event delivered before this
 * change dedupe against the delivery that was missing the identity. The
 * fix would land and the traffic it was meant to repair would never be
 * re-sent.
 */
export const NORMALIZE_VERSION = "v3" as const;
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
