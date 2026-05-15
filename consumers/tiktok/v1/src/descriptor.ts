/**
 * TikTok Events API v1 destination descriptor.
 *
 * Per `docs/architecture/06-destinations.md`, every destination consumer
 * declares a `DestinationDescriptor` that the runtime composes into the
 * MAP + DELIVER + RECORD pipeline.
 *
 * Mirrors `consumers/meta-capi/v1/src/descriptor.ts`: an explicit
 * canonical → vendor event matrix via a frozen `MapperMap`. Events
 * outside the matrix land as `mapped_failed` records at the runtime
 * layer — operators see the "no mapper registered" reason and route
 * their schema work accordingly.
 *
 *   - identity            pinned vendor + per-stage versions
 *   - mappers             per-canonical-event TikTok payload builders
 *   - deliverer           HTTPS POST to business-api.tiktok.com/open_api/
 *                         <version>/event/track/
 *   - requiredConsent     marketing=true (TikTok carries marketing payloads)
 *   - identityHashing     hash both email + phone (TikTok requires it)
 */

import type {
  IdentityHashingOptions,
  RequiredConsent,
} from "@polaris/shared-destination-normalize";
import type { DestinationDescriptor, MapperMap } from "@polaris/shared-destinations";

import { type BuildDelivererOptions, buildTikTokDeliverer } from "./deliverer.js";
import { CONSUMER_IDENTITY } from "./descriptor-identity.js";
import { checkoutStartedMapper, paymentApprovedMapper, userIdentifiedMapper } from "./mapper.js";
import type { TikTokEventPayload } from "./types.js";

/**
 * TikTok carries marketing payloads — Polaris drops events when the
 * envelope declares marketing=false. analytics + personalization stay
 * at receiver discretion (TikTok's own ad-personalization toggle is a
 * separate signal carried via the `limited_data_use` flag).
 */
const REQUIRED_CONSENT: RequiredConsent = Object.freeze({ marketing: true });

/** Hash both email and phone — TikTok requires sha256-lowercase-trim. */
const IDENTITY_HASHING: IdentityHashingOptions = Object.freeze({
  email: true,
  phone: true,
});

/**
 * Per-canonical-event mapper map. Frozen so runtime mutations (test or
 * otherwise) can't widen the set without a descriptor rebuild.
 */
const MAPPERS: MapperMap<TikTokEventPayload> = Object.freeze({
  "checkout.started": checkoutStartedMapper,
  "payment.approved": paymentApprovedMapper,
  "user.identified": userIdentifiedMapper,
});

/** Options accepted by `createTikTokDescriptor`. */
export interface CreateTikTokDescriptorOptions extends BuildDelivererOptions {}

/** Build the `DestinationDescriptor` for tiktok v1. */
export function createTikTokDescriptor(
  options: CreateTikTokDescriptorOptions,
): DestinationDescriptor<TikTokEventPayload> {
  return {
    identity: CONSUMER_IDENTITY,
    mappers: MAPPERS,
    deliverer: buildTikTokDeliverer(options),
    requiredConsent: REQUIRED_CONSENT,
    identityHashing: IDENTITY_HASHING,
  };
}
