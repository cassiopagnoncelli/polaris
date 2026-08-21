/**
 * Braze REST API v1 destination connector.
 *
 * The `destination.port` implementation for Braze: what the vendor is
 * called, which canonical events it maps, how a mapped payload reaches
 * rest.<instance>.braze.com, and what consent it requires before either
 * happens. Everything a deployment knows — broker, database, HTTP port — is
 * the unit's (`sync/destinations/braze/v1`), and nothing here reaches for it.
 *
 * Mirrors `connectors/destinations/tiktok/v1`: an explicit canonical →
 * vendor event matrix via a frozen `MapperMap`. Events outside the matrix
 * land as `mapped_failed` records at the runtime layer — operators see the
 * "no mapper registered" reason and route their schema work accordingly.
 *
 *   - identity            pinned vendor + per-stage versions
 *   - map                 per-canonical-event Braze payload builders
 *   - deliver             HTTPS POST to rest.<instance>.braze.com/users/track
 *   - requiredConsent     marketing=true (Braze carries marketing payloads)
 *   - identityHashing     OFF for both email + phone — Braze's REST API
 *                         consumes raw identifiers (it hashes server-side
 *                         for its own dedupe)
 */

import type { DestinationDescriptor, MapperMap } from "@polaris/delivery-destinations";
import type {
  IdentityHashingOptions,
  RawIdentityInput,
  RequiredConsent,
} from "@polaris/delivery-normalize";
import {
  type DestinationConnector,
  defineDestinationConnector,
  toDestinationDescriptor,
} from "@polaris/delivery-port";

import { type BuildDelivererOptions, buildBrazeDeliverer } from "./deliverer.js";
import { CONSUMER_IDENTITY } from "./descriptor-identity.js";
import {
  audienceEnteredMapper,
  audienceExitedMapper,
  checkoutStartedMapper,
  journeyEnteredMapper,
  journeyExitedMapper,
  journeyStepAdvancedMapper,
  paymentApprovedMapper,
  userIdentifiedMapper,
} from "./mapper.js";
import { PROJECT_CONFIG_NAMESPACE } from "./project-config.js";
import type { BrazePayload } from "./types.js";

/**
 * Braze carries marketing payloads (push, email, in-app, SMS) — Polaris
 * drops events when the envelope declares marketing=false. analytics +
 * personalization stay at receiver discretion.
 */
const REQUIRED_CONSENT: RequiredConsent = Object.freeze({ marketing: true });

/**
 * Braze's REST API consumes RAW email/phone (the vendor hashes
 * server-side for its own dedupe / messaging audit). Both flags are
 * `false` so the shared normalize layer leaves `identity.email` /
 * `identity.phone` populated with the raw value the producer supplied.
 */
const IDENTITY_HASHING: IdentityHashingOptions = Object.freeze({
  email: false,
  phone: false,
});

/**
 * Per-canonical-event mapper map. Frozen so runtime mutations (test or
 * otherwise) can't widen the set without a descriptor rebuild.
 */
const MAPPERS: MapperMap<BrazePayload> = Object.freeze({
  "checkout.started": checkoutStartedMapper,
  "payment.approved": paymentApprovedMapper,
  "user.identified": userIdentifiedMapper,
  // Profile-plane events. Reachable because the consumer subscribes to
  // `profile.events` as well as the spine (see app.ts); whether a given
  // instance actually receives them is the routing gate's decision.
  "audience.entered": audienceEnteredMapper,
  "audience.exited": audienceExitedMapper,
  // The journey plane. §6.1 says a journey action reaches "any vendor";
  // until this landed, only webhook-sink's passthrough carried one, so the
  // promise held for a receiver that accepts anything and for no vendor
  // that maps. The action is the custom event; entering and leaving are
  // membership attributes a campaign suppresses on.
  "journey.step_advanced": journeyStepAdvancedMapper,
  "journey.entered": journeyEnteredMapper,
  "journey.exited": journeyExitedMapper,
});

/**
 * Surface raw email + phone from the canonical envelope's `properties`
 * block into the prepared identity. The canonical envelope's
 * `identity` block only carries id-shaped fields (`customer_id`,
 * `anonymous_id`, ...); producers ship raw email/phone via the
 * `properties` slot. This hook lets the shared normalize layer pick
 * them up at the destination boundary so the mapper sees a uniform
 * `PreparedIdentity` regardless of where the producer placed the data.
 *
 * It is no longer the ONLY source, and is kept because it is still the
 * better one. Since 1VEL3 the normalizer falls back to the profile-trait
 * snapshot for the whole match set, which is what fills `email` on the
 * ordinary resolved event of a known person — this hook covers the event
 * that carries a NEWER address than the snapshot taken when it was
 * enriched, and `normalizeForDestination` spreads it second so it wins.
 *
 * Returns `undefined` when neither slot is present, and the two sources
 * being absent together is what leaves the identity slots `null`. The
 * mapper then emits `attributes[]` entries without `email` / `phone`
 * fields, which Braze accepts (it just updates the profile with
 * `external_id` + `language` + `_update_existing_only=false`).
 */
function identityFromProperties(
  properties: Readonly<Record<string, unknown>>,
): Pick<RawIdentityInput, "email" | "phone"> | undefined {
  const email = readNonEmpty(properties, "email");
  const phone = readNonEmpty(properties, "phone");
  if (email === null && phone === null) return undefined;
  const out: { email?: string; phone?: string } = {};
  if (email !== null) out.email = email;
  if (phone !== null) out.phone = phone;
  return out;
}

function readNonEmpty(props: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = props[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Options accepted by `createBrazeDescriptor`. */
export interface CreateBrazeDescriptorOptions extends BuildDelivererOptions {}

/**
 * The Braze registry entry.
 *
 * `event` only today. Braze's list surface is its subscription groups and
 * segments API — a different endpoint with different semantics — and no
 * code here speaks it, so audience-sync has nothing to call. The mode
 * array is where that changes when it does.
 */
export const brazeConnector: DestinationConnector<BrazePayload, CreateBrazeDescriptorOptions> =
  defineDestinationConnector({
    slug: "braze",
    supportedModes: ["event"],
    identity: CONSUMER_IDENTITY,
    projectConfigNamespace: PROJECT_CONFIG_NAMESPACE,
    map: MAPPERS,
    deliver: buildBrazeDeliverer,
    requiredConsent: REQUIRED_CONSENT,
    identityHashing: IDENTITY_HASHING,
    identityFromProperties,
  });

/** Build the `DestinationDescriptor` the shared runtime binds to. */
export function createBrazeDescriptor(
  options: CreateBrazeDescriptorOptions,
): DestinationDescriptor<BrazePayload> {
  return toDestinationDescriptor(brazeConnector, options);
}
