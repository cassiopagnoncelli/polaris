/**
 * Meta CAPI v1 destination descriptor.
 *
 * Per `docs/architecture/06-destinations.md`, every destination consumer
 * declares a `DestinationDescriptor` that the runtime composes into the
 * MAP + DELIVER + RECORD pipeline.
 *
 * Unlike webhook-sink (which uses a passthrough mapper Proxy), this
 * descriptor enumerates the explicit canonical → vendor event matrix
 * via a frozen `MapperMap`. Events outside the matrix land as
 * `mapped_failed` records at the runtime layer — operators see the
 * "no mapper registered" reason and route their schema work
 * accordingly.
 *
 *   - identity            pinned vendor + per-stage versions
 *   - mappers             per-canonical-event Meta payload builders
 *   - deliverer           HTTPS POST to graph.facebook.com/<version>/
 *                         <pixel_id>/events
 *   - requiredConsent     marketing=true (Meta carries marketing payloads)
 *   - identityHashing     hash both email + phone (Meta requires it)
 */

import type {
  IdentityHashingOptions,
  RequiredConsent,
} from "@polaris/shared-destination-normalize";
import type { DestinationDescriptor, MapperMap } from "@polaris/shared-destinations";

import { type BuildDelivererOptions, buildMetaCapiDeliverer } from "./deliverer.js";
import { CONSUMER_IDENTITY } from "./descriptor-identity.js";
import { checkoutStartedMapper, paymentApprovedMapper, userIdentifiedMapper } from "./mapper.js";
import type { MetaCapiPayload } from "./types.js";

/**
 * Meta carries marketing payloads — Polaris drops events when the
 * envelope declares marketing=false. analytics + personalization stay
 * at receiver discretion (Meta's own ad-personalization toggle is a
 * separate signal carried via `data_processing_options` LDU flag).
 */
const REQUIRED_CONSENT: RequiredConsent = Object.freeze({ marketing: true });

/** Hash both email and phone — Meta requires sha256-lowercase-trim. */
const IDENTITY_HASHING: IdentityHashingOptions = Object.freeze({
  email: true,
  phone: true,
});

/**
 * Per-canonical-event mapper map. Frozen so runtime mutations (test or
 * otherwise) can't widen the set without a descriptor rebuild.
 */
const MAPPERS: MapperMap<MetaCapiPayload> = Object.freeze({
  "checkout.started": checkoutStartedMapper,
  "payment.approved": paymentApprovedMapper,
  "user.identified": userIdentifiedMapper,
});

/** Options accepted by `createMetaCapiDescriptor`. */
export interface CreateMetaCapiDescriptorOptions extends BuildDelivererOptions {}

/** Build the `DestinationDescriptor` for meta-capi v1. */
export function createMetaCapiDescriptor(
  options: CreateMetaCapiDescriptorOptions,
): DestinationDescriptor<MetaCapiPayload> {
  return {
    identity: CONSUMER_IDENTITY,
    mappers: MAPPERS,
    deliverer: buildMetaCapiDeliverer(options),
    requiredConsent: REQUIRED_CONSENT,
    identityHashing: IDENTITY_HASHING,
  };
}
