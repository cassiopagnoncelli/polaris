/**
 * GA4 Measurement Protocol v1 destination connector.
 *
 * The `destination.port` implementation for GA4: what the vendor is called,
 * which canonical events it maps, how a mapped payload reaches Google, and
 * what consent it requires before either happens. Everything a deployment
 * knows — broker, database, HTTP port — is the unit's
 * (`sync/destinations/ga4/v1`), and nothing here reaches for it.
 *
 * Mirrors `connectors/destinations/tiktok/v1`: an explicit canonical →
 * vendor event matrix via a frozen `MapperMap`. Events outside the matrix
 * land as `mapped_failed` records at the runtime layer — operators see the
 * "no mapper registered" reason and route their schema work accordingly.
 *
 *   - identity            pinned vendor + per-stage versions
 *   - map                 per-canonical-event GA4 payload builders
 *   - deliver             HTTPS POST to www.google-analytics.com/mp/collect
 *                         with measurement_id + api_secret query string
 *   - requiredConsent     analytics=true (GA4 carries analytics payloads)
 *   - identityHashing     off (GA4 does not consume hashed identifiers)
 */

import type { DestinationDescriptor, MapperMap } from "@polaris/delivery-destinations";
import type { IdentityHashingOptions, RequiredConsent } from "@polaris/delivery-normalize";
import {
  type DestinationConnector,
  defineDestinationConnector,
  toDestinationDescriptor,
} from "@polaris/delivery-port";

import { type BuildDelivererOptions, buildGa4Deliverer } from "./deliverer.js";
import { CONSUMER_IDENTITY } from "./descriptor-identity.js";
import {
  checkoutStartedMapper,
  paymentApprovedMapper,
  signupCompletedMapper,
  subscriptionRenewedMapper,
  userIdentifiedMapper,
} from "./mapper.js";
import { PROJECT_CONFIG_NAMESPACE } from "./project-config.js";
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
 * otherwise) can't widen the set without a rebuild.
 */
const MAPPERS: MapperMap<Ga4EventPayload> = Object.freeze({
  "checkout.started": checkoutStartedMapper,
  "payment.approved": paymentApprovedMapper,
  "user.identified": userIdentifiedMapper,
  "signup.completed": signupCompletedMapper,
  "subscription.renewed": subscriptionRenewedMapper,
});

/** Options accepted by `createGa4Descriptor`. */
export interface CreateGa4DescriptorOptions extends BuildDelivererOptions {}

/**
 * The GA4 registry entry.
 *
 * `event` only: GA4's Measurement Protocol has no list-membership surface,
 * so an audience-sync job has nothing to call here. Declaring the mode it
 * does NOT support is the point — a dispatcher can refuse the job instead
 * of discovering the gap mid-delivery.
 */
export const ga4Connector: DestinationConnector<Ga4EventPayload, CreateGa4DescriptorOptions> =
  defineDestinationConnector({
    slug: "ga4",
    supportedModes: ["event"],
    identity: CONSUMER_IDENTITY,
    projectConfigNamespace: PROJECT_CONFIG_NAMESPACE,
    map: MAPPERS,
    deliver: buildGa4Deliverer,
    requiredConsent: REQUIRED_CONSENT,
    identityHashing: IDENTITY_HASHING,
  });

/** Build the `DestinationDescriptor` the shared runtime binds to. */
export function createGa4Descriptor(
  options: CreateGa4DescriptorOptions,
): DestinationDescriptor<Ga4EventPayload> {
  return toDestinationDescriptor(ga4Connector, options);
}
