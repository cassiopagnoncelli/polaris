/**
 * GA4 Measurement Protocol v1 destination descriptor.
 *
 * Per `docs/architecture/06-destinations.md`, every destination consumer
 * declares a `DestinationDescriptor` that the runtime composes into the
 * MAP + DELIVER + RECORD pipeline.
 *
 * Mirrors `consumers/tiktok/v1/src/descriptor.ts`: an explicit canonical
 * → vendor event matrix via a frozen `MapperMap`. Events outside the
 * matrix land as `mapped_failed` records at the runtime layer —
 * operators see the "no mapper registered" reason and route their
 * schema work accordingly.
 *
 *   - identity            pinned vendor + per-stage versions
 *   - mappers             per-canonical-event GA4 payload builders
 *   - deliverer           HTTPS POST to www.google-analytics.com/mp/collect
 *                         with measurement_id + api_secret query string
 *   - requiredConsent     analytics=true (GA4 carries analytics payloads)
 *   - identityHashing     off (GA4 does not consume hashed identifiers)
 */

import type {
  IdentityHashingOptions,
  RequiredConsent,
} from "@polaris/shared-destination-normalize";
import type { DestinationDescriptor, MapperMap } from "@polaris/shared-destinations";

import { type BuildDelivererOptions, buildGa4Deliverer } from "./deliverer.js";
import { CONSUMER_IDENTITY } from "./descriptor-identity.js";
import { checkoutStartedMapper, paymentApprovedMapper, userIdentifiedMapper } from "./mapper.js";
import type { Ga4EventPayload } from "./types.js";

/**
 * GA4 carries analytics payloads — Polaris drops events when the
 * envelope declares analytics=false. Marketing + personalization stay
 * at receiver discretion; GA4 surfaces them through separate consent
 * mode signals on the gtag side that v1 does not yet flatten through
 * the Measurement Protocol.
 */
const REQUIRED_CONSENT: RequiredConsent = Object.freeze({ analytics: true });

/**
 * GA4 consumes `client_id` / `user_id` as raw opaque strings — no
 * hashing required. We keep both flags off so the shared normalize
 * layer doesn't burn CPU producing `email_sha256` / `phone_sha256`
 * slots the GA4 mapper never reads.
 */
const IDENTITY_HASHING: IdentityHashingOptions = Object.freeze({
  email: false,
  phone: false,
});

/**
 * Per-canonical-event mapper map. Frozen so runtime mutations (test or
 * otherwise) can't widen the set without a descriptor rebuild.
 */
const MAPPERS: MapperMap<Ga4EventPayload> = Object.freeze({
  "checkout.started": checkoutStartedMapper,
  "payment.approved": paymentApprovedMapper,
  "user.identified": userIdentifiedMapper,
});

/** Options accepted by `createGa4Descriptor`. */
export interface CreateGa4DescriptorOptions extends BuildDelivererOptions {}

/** Build the `DestinationDescriptor` for ga4 v1. */
export function createGa4Descriptor(
  options: CreateGa4DescriptorOptions,
): DestinationDescriptor<Ga4EventPayload> {
  return {
    identity: CONSUMER_IDENTITY,
    mappers: MAPPERS,
    deliverer: buildGa4Deliverer(options),
    requiredConsent: REQUIRED_CONSENT,
    identityHashing: IDENTITY_HASHING,
  };
}
