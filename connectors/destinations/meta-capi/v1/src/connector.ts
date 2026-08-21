/**
 * Meta Conversions API v1 destination connector.
 *
 * The `destination.port` implementation for Meta CAPI: what the vendor is
 * called, which canonical events it maps, how a mapped payload reaches
 * graph.facebook.com, and what consent it requires before either happens.
 * Everything a deployment knows — broker, database, HTTP port — is the
 * unit's (`sync/destinations/meta-capi/v1`), and nothing here reaches for it.
 *
 * An explicit canonical → vendor event matrix via a frozen `MapperMap`.
 * Events outside the matrix land as `mapped_failed` records at the runtime
 * layer — operators see the "no mapper registered" reason and route their
 * schema work accordingly.
 *
 *   - identity            pinned vendor + per-stage versions
 *   - map                 per-canonical-event Meta CAPI payload builders
 *   - deliver             HTTPS POST to graph.facebook.com/<version>/<pixel>/events
 *   - requiredConsent     marketing=true (CAPI carries advertising payloads)
 *   - identityHashing     on (Meta requires SHA-256 identifiers)
 */

import type { DestinationDescriptor, MapperMap } from "@polaris/delivery-destinations";
import type { IdentityHashingOptions, RequiredConsent } from "@polaris/delivery-normalize";
import {
  type DestinationConnector,
  defineDestinationConnector,
  toDestinationDescriptor,
} from "@polaris/delivery-port";

import { type BuildDelivererOptions, buildMetaCapiDeliverer } from "./deliverer.js";
import { CONSUMER_IDENTITY } from "./descriptor-identity.js";
import {
  checkoutStartedMapper,
  paymentApprovedMapper,
  signupCompletedMapper,
  subscriptionRenewedMapper,
  userIdentifiedMapper,
} from "./mapper.js";
import { PROJECT_CONFIG_NAMESPACE } from "./project-config.js";
import type { MetaCapiPayload } from "./types.js";

const REQUIRED_CONSENT: RequiredConsent = Object.freeze({ marketing: true });

const IDENTITY_HASHING: IdentityHashingOptions = Object.freeze({
  email: true,
  phone: true,
});

const MAPPERS: MapperMap<MetaCapiPayload> = Object.freeze({
  "checkout.started": checkoutStartedMapper,
  "payment.approved": paymentApprovedMapper,
  "user.identified": userIdentifiedMapper,
  "signup.completed": signupCompletedMapper,
  "subscription.renewed": subscriptionRenewedMapper,
});

/** Options accepted by `createMetaCapiDescriptor`. */
export interface CreateMetaCapiDescriptorOptions extends BuildDelivererOptions {}

/**
 * The Meta CAPI registry entry.
 *
 * `event` only: Meta's Custom Audience list API is a different surface with
 * different credentials, and no code here speaks it. When audience-sync
 * needs it, `list` joins this array and the list operations land beside
 * `deliver` — not in a second connector.
 */
export const metaCapiConnector: DestinationConnector<
  MetaCapiPayload,
  CreateMetaCapiDescriptorOptions
> = defineDestinationConnector({
  slug: "meta-capi",
  supportedModes: ["event"],
  identity: CONSUMER_IDENTITY,
  projectConfigNamespace: PROJECT_CONFIG_NAMESPACE,
  map: MAPPERS,
  deliver: buildMetaCapiDeliverer,
  requiredConsent: REQUIRED_CONSENT,
  identityHashing: IDENTITY_HASHING,
});

/** Build the `DestinationDescriptor` the shared runtime binds to. */
export function createMetaCapiDescriptor(
  options: CreateMetaCapiDescriptorOptions,
): DestinationDescriptor<MetaCapiPayload> {
  return toDestinationDescriptor(metaCapiConnector, options);
}
