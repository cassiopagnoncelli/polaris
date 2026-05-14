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
export const CONSUMER_VERSION = "v1" as const;
export const NORMALIZE_VERSION = "v1" as const;
export const MAPPER_VERSION = "v1" as const;
export const DELIVERER_VERSION = "v1" as const;

export const CONSUMER_IDENTITY: ConsumerIdentity = {
  vendor: CONSUMER_VENDOR,
  consumerVersion: CONSUMER_VERSION,
  normalizeVersion: NORMALIZE_VERSION,
  mapperVersion: MAPPER_VERSION,
  delivererVersion: DELIVERER_VERSION,
};
