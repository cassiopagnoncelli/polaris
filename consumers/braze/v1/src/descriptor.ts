/**
 * Braze REST API v1 destination descriptor.
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
 *   - mappers             per-canonical-event Braze payload builders
 *   - deliverer           HTTPS POST to rest.<instance>.braze.com/users/track
 *   - requiredConsent     marketing=true (Braze carries marketing payloads)
 *   - identityHashing     OFF for both email + phone — Braze's REST API
 *                         consumes raw identifiers (it hashes server-side
 *                         for its own dedupe)
 */

import type { DestinationDescriptor, MapperMap } from "@polaris/shared-destinations";
import type {
  IdentityHashingOptions,
  RawIdentityInput,
  RequiredConsent,
} from "@polaris/shared-destination-normalize";

import { buildBrazeDeliverer, type BuildDelivererOptions } from "./deliverer.js";
import { CONSUMER_IDENTITY } from "./descriptor-identity.js";
import { checkoutStartedMapper, paymentApprovedMapper, userIdentifiedMapper } from "./mapper.js";
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
 * Returns `undefined` when neither slot is present; the normalize
 * layer leaves the identity slots `null`. The mapper then emits
 * `attributes[]` entries without `email` / `phone` fields, which
 * Braze accepts (it just updates the profile with `external_id` +
 * `language` + `_update_existing_only=false`).
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

/** Build the `DestinationDescriptor` for braze v1. */
export function createBrazeDescriptor(
  options: CreateBrazeDescriptorOptions,
): DestinationDescriptor<BrazePayload> {
  return {
    identity: CONSUMER_IDENTITY,
    mappers: MAPPERS,
    deliverer: buildBrazeDeliverer(options),
    requiredConsent: REQUIRED_CONSENT,
    identityHashing: IDENTITY_HASHING,
    identityFromProperties,
  };
}
