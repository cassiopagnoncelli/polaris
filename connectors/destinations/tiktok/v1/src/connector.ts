/**
 * TikTok Events API v1 destination connector.
 *
 * The `destination.port` implementation for TikTok: what the vendor is
 * called, which canonical events it maps, how a mapped payload reaches
 * business-api.tiktok.com, and what consent it requires before either
 * happens. Everything a deployment knows — broker, database, HTTP port — is
 * the unit's (`sync/destinations/tiktok/v1`), and nothing here reaches for
 * it.
 *
 * An explicit canonical → vendor event matrix via a frozen `MapperMap`.
 * Events outside the matrix land as `skipped_unmapped` records at the
 * runtime layer (H05QEWIB) — operators see the "no mapper registered"
 * reason and route their schema work accordingly.
 *
 *   - identity            pinned vendor + per-stage versions
 *   - map                 per-canonical-event TikTok payload builders
 *   - deliver             HTTPS POST to the Events API with Access-Token auth
 *   - requiredConsent     marketing=true (Events API carries advertising payloads)
 *   - identityHashing     on (TikTok requires SHA-256 identifiers)
 */

import type { DestinationDescriptor, MapperMap } from "@polaris/delivery-destinations";
import type { IdentityHashingOptions, RequiredConsent } from "@polaris/delivery-normalize";
import {
  type DestinationConnector,
  defineDestinationConnector,
  toDestinationDescriptor,
} from "@polaris/delivery-port";

import { type BuildDelivererOptions, buildTikTokDeliverer } from "./deliverer.js";
import { CONSUMER_IDENTITY } from "./descriptor-identity.js";
import {
  checkoutStartedMapper,
  pageViewedMapper,
  paymentApprovedMapper,
  signupCompletedMapper,
  subscriptionRenewedMapper,
  userIdentifiedMapper,
} from "./mapper.js";
import { PROJECT_CONFIG_NAMESPACE } from "./project-config.js";
import type { TikTokEventPayload } from "./types.js";

const REQUIRED_CONSENT: RequiredConsent = Object.freeze({ marketing: true });

const IDENTITY_HASHING: IdentityHashingOptions = Object.freeze({
  email: true,
  phone: true,
});

const MAPPERS: MapperMap<TikTokEventPayload> = Object.freeze({
  "page.viewed": pageViewedMapper,
  "checkout.started": checkoutStartedMapper,
  "payment.approved": paymentApprovedMapper,
  "user.identified": userIdentifiedMapper,
  "signup.completed": signupCompletedMapper,
  "subscription.renewed": subscriptionRenewedMapper,
});

/** Options accepted by `createTikTokDescriptor`. */
export interface CreateTikTokDescriptorOptions extends BuildDelivererOptions {}

/** The TikTok registry entry. `event` only; no list surface is implemented. */
export const tiktokConnector: DestinationConnector<
  TikTokEventPayload,
  CreateTikTokDescriptorOptions
> = defineDestinationConnector({
  slug: "tiktok",
  supportedModes: ["event"],
  identity: CONSUMER_IDENTITY,
  projectConfigNamespace: PROJECT_CONFIG_NAMESPACE,
  map: MAPPERS,
  deliver: buildTikTokDeliverer,
  requiredConsent: REQUIRED_CONSENT,
  identityHashing: IDENTITY_HASHING,
});

/** Build the `DestinationDescriptor` the shared runtime binds to. */
export function createTikTokDescriptor(
  options: CreateTikTokDescriptorOptions,
): DestinationDescriptor<TikTokEventPayload> {
  return toDestinationDescriptor(tiktokConnector, options);
}
