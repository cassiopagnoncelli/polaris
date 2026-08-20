/**
 * Meta CAPI v1 mappers.
 *
 * Per `docs/architecture/06-destinations.md`, the mapper is the MAP stage
 * of the destination pipeline. It is pure: no I/O, no clock, no PII reach
 * (the `MapperContext` doesn't carry the raw envelope).
 *
 * Each per-canonical-event mapper produces a `MetaCapiPayload` matching
 * Meta's CAPI request body shape. Vendor dedupe always keys on the
 * canonical `event_id` so Meta deduplicates cross-channel attempts
 * (e.g. browser pixel + server CAPI for the same checkout) without
 * Polaris having to invent a vendor-specific dedupe key.
 *
 * v1 covers the commerce subset that production Meta integrations
 * usually start with:
 *
 *   - `checkout.started`  → `InitiateCheckout`
 *   - `payment.approved`  → `Purchase`
 *   - `user.identified`   → `Lead`
 *
 * Events outside this set produce `mapped_failed` records at the
 * runtime layer (no mapper registered).
 *
 * Action-source inference lives in `inferActionSource` and consults the
 * canonical `context.source.type` plus a light heuristic on whether the
 * page_url / user_agent slots are populated. Vendor consumers are
 * allowed to add per-mapper overrides; v1 keeps the inference uniform.
 */

import type { NormalizedEvent } from "@polaris/delivery-normalize";
import { hasAppContext, minorToMajor, sha256Hex } from "@polaris/delivery-normalize";
import type { Mapper, MapperContext, MapperResult } from "@polaris/delivery-destinations";

import type {
  MetaActionSource,
  MetaCapiCustomData,
  MetaCapiPayload,
  MetaCapiUserData,
} from "./types.js";

/**
 * Mutable build-up shape for `MetaCapiCustomData`. The mapper assembles
 * it field-by-field and the helper that constructs the `MetaCapiPayload`
 * spreads it through `Object.keys(...)` so the wire object only carries
 * fields the mapper actually populated.
 */
type CustomDataBuilder = {
  -readonly [K in keyof MetaCapiCustomData]: MetaCapiCustomData[K];
};

// ---------------------------------------------------------------------------
// Meta event name constants
// ---------------------------------------------------------------------------

export const META_EVENT_PURCHASE = "Purchase" as const;
export const META_EVENT_INITIATE_CHECKOUT = "InitiateCheckout" as const;
export const META_EVENT_LEAD = "Lead" as const;
export const META_EVENT_COMPLETE_REGISTRATION = "CompleteRegistration" as const;
export const META_EVENT_SUBSCRIBE = "Subscribe" as const;

/**
 * Closed-set mapping from canonical event name → Meta event name. The
 * descriptor uses this map as the keys for the per-event `MapperMap`.
 */
export const CANONICAL_TO_META_EVENT = Object.freeze({
  "checkout.started": META_EVENT_INITIATE_CHECKOUT,
  "payment.approved": META_EVENT_PURCHASE,
  "user.identified": META_EVENT_LEAD,
  "signup.completed": META_EVENT_COMPLETE_REGISTRATION,
  "subscription.renewed": META_EVENT_SUBSCRIBE,
}) as Readonly<Record<string, string>>;

// ---------------------------------------------------------------------------
// Per-event mappers
// ---------------------------------------------------------------------------

/**
 * `checkout.started` → `InitiateCheckout`.
 *
 * Pulls `currency` + `total` (in minor units) off `properties`; converts
 * to major units for Meta's `custom_data.value` field. `num_items` is
 * derived from `items[].quantity` sum when present.
 */
export const checkoutStartedMapper: Mapper<MetaCapiPayload> = (
  ctx: MapperContext,
): MapperResult<MetaCapiPayload> => {
  const props = ctx.normalized.properties;
  const currency = readString(props, "currency");
  const totalMinor = readInteger(props, "total");
  const items = readArray(props, "items");

  const customData: CustomDataBuilder = {};
  if (currency !== null && totalMinor !== null) {
    customData.currency = currency;
    const value = safeMinorToMajor(totalMinor, currency);
    if (value !== undefined) customData.value = value;
  } else if (currency !== null) {
    customData.currency = currency;
  }
  if (items !== null) {
    const numItems = sumItemQuantities(items);
    if (numItems > 0) customData.num_items = numItems;
  }
  const cartId = readString(props, "cart_id");
  if (cartId !== null) customData.order_id = cartId;

  return buildResult(ctx.normalized, META_EVENT_INITIATE_CHECKOUT, customData);
};

/**
 * `payment.approved` → `Purchase`.
 *
 * Pulls `amount` / `currency` / `order_id` (the payments-API shape,
 * convention from `definitions/sources/storefront/payments-api.yaml`).
 * v1 is conservative: when properties don't carry `amount_minor` +
 * `currency`, the custom_data block omits the `value` slot and Meta
 * still accepts the event (it just can't compute ROAS for that row).
 */
export const paymentApprovedMapper: Mapper<MetaCapiPayload> = (
  ctx: MapperContext,
): MapperResult<MetaCapiPayload> => {
  const props = ctx.normalized.properties;
  const currency = readString(props, "currency");
  const amountMinor = readInteger(props, "amount_minor") ?? readInteger(props, "amount");
  const customData: CustomDataBuilder = {};
  if (currency !== null && amountMinor !== null) {
    customData.currency = currency;
    const value = safeMinorToMajor(amountMinor, currency);
    if (value !== undefined) customData.value = value;
  } else if (currency !== null) {
    customData.currency = currency;
  }
  const orderId = readString(props, "order_id") ?? readString(props, "transaction_id");
  if (orderId !== null) customData.order_id = orderId;

  return buildResult(ctx.normalized, META_EVENT_PURCHASE, customData);
};

/**
 * `user.identified` → `Lead`.
 *
 * Lightweight conversion event Meta uses for non-purchase intent
 * signals. Custom data carries no value/currency by default.
 */
export const userIdentifiedMapper: Mapper<MetaCapiPayload> = (
  ctx: MapperContext,
): MapperResult<MetaCapiPayload> => {
  return buildResult(ctx.normalized, META_EVENT_LEAD, {});
};

/**
 * `signup.completed` → `CompleteRegistration`.
 *
 * Pulls `predicted_ltv_minor` + `currency` off `properties` when present;
 * Meta uses `predicted_ltv` on `CompleteRegistration` events to inform
 * the lookalike-modelling pipeline. Most signup events do not carry a
 * value (registrations without a paid component); v1 leaves the custom
 * data empty in that case rather than fabricating a placeholder.
 */
export const signupCompletedMapper: Mapper<MetaCapiPayload> = (
  ctx: MapperContext,
): MapperResult<MetaCapiPayload> => {
  const props = ctx.normalized.properties;
  const currency = readString(props, "currency");
  const predictedLtvMinor = readInteger(props, "predicted_ltv_minor");

  const customData: CustomDataBuilder = {};
  if (currency !== null && predictedLtvMinor !== null) {
    customData.currency = currency;
    const ltv = safeMinorToMajor(predictedLtvMinor, currency);
    if (ltv !== undefined) customData.predicted_ltv = ltv;
  }

  return buildResult(ctx.normalized, META_EVENT_COMPLETE_REGISTRATION, customData);
};

/**
 * `subscription.renewed` → `Subscribe`.
 *
 * The renewal carries the recurring amount as `amount_minor` (or
 * `amount` for legacy producers) plus `currency`. `predicted_ltv` —
 * when supplied — is forwarded to Meta's recurring-revenue model. The
 * order_id slot carries the subscription id so Meta receives a stable
 * vendor-side identifier per renewal cycle (Meta's wire `event_id`
 * still uses the canonical envelope id for cross-channel dedupe).
 */
export const subscriptionRenewedMapper: Mapper<MetaCapiPayload> = (
  ctx: MapperContext,
): MapperResult<MetaCapiPayload> => {
  const props = ctx.normalized.properties;
  const currency = readString(props, "currency");
  const amountMinor = readInteger(props, "amount_minor") ?? readInteger(props, "amount");
  const predictedLtvMinor = readInteger(props, "predicted_ltv_minor");
  const subscriptionId = readString(props, "subscription_id");

  const customData: CustomDataBuilder = {};
  if (currency !== null && amountMinor !== null) {
    customData.currency = currency;
    const value = safeMinorToMajor(amountMinor, currency);
    if (value !== undefined) customData.value = value;
  } else if (currency !== null) {
    customData.currency = currency;
  }
  if (currency !== null && predictedLtvMinor !== null) {
    const ltv = safeMinorToMajor(predictedLtvMinor, currency);
    if (ltv !== undefined) customData.predicted_ltv = ltv;
  }
  if (subscriptionId !== null) customData.order_id = subscriptionId;

  return buildResult(ctx.normalized, META_EVENT_SUBSCRIBE, customData);
};

// ---------------------------------------------------------------------------
// Action source inference
// ---------------------------------------------------------------------------

/**
 * Closed-set inference of Meta's `action_source` from canonical context.
 *
 *   - any `app_*` slot populated         → `app` (G7ZCYLL6)
 *   - `context.page_url` populated       → `website`
 *   - otherwise                          → `system_generated` (Meta-safe default)
 *
 * `app` takes precedence over `website` because a native-app SDK may
 * report both a `page_url` (in-app webview) and an `app_*` slot; Meta's
 * attribution model expects `app` in that case.
 *
 * Misreporting action_source affects Meta's ad-attribution model, so v1
 * stays narrow — only flips to `app` when the canonical envelope
 * explicitly carries an app context.
 */
export function inferActionSource(normalized: NormalizedEvent): MetaActionSource {
  if (hasAppContext(normalized.context)) {
    return "app";
  }
  if (normalized.context.page_url !== null) {
    return "website";
  }
  return "system_generated";
}

// ---------------------------------------------------------------------------
// User_data builder
// ---------------------------------------------------------------------------

/**
 * Build Meta's `user_data` block from the normalized identity + context.
 *
 * Hashed fields (em, ph, external_id) come from the shared normalize
 * layer (sha256-lowercase-trim email; sha256 of E.164 phone;
 * sha256(`customer_id`) for external_id when no other slot applies).
 * Raw fields (fbp, fbc, client_ip_address, client_user_agent) pass
 * through unchanged.
 */
export function buildUserData(normalized: NormalizedEvent): MetaCapiUserData {
  const userData: {
    em?: string[];
    ph?: string[];
    external_id?: string[];
    fbp?: string;
    fbc?: string;
    client_ip_address?: string;
    client_user_agent?: string;
    anon_id?: string;
  } = {};

  if (normalized.identity.email_sha256 !== null) {
    userData.em = [normalized.identity.email_sha256];
  }
  if (normalized.identity.phone_sha256 !== null) {
    userData.ph = [normalized.identity.phone_sha256];
  }
  // `external_id` is Meta's cross-session join key, so it should carry the
  // most durable id Polaris has for the person. `canonical_customer_id` is
  // the identity stage's conclusion after reconciling every identifier ever
  // seen; `user_id` is what this one event's producer happened to send. Two
  // producers spelling the same customer differently used to land as two
  // Meta users and now converge.
  //
  // Prior behaviour is preserved exactly when there is no resolution to
  // use — an envelope off `analytics.events`, or a person the resolver has
  // not linked to a customer id — so nothing changes for traffic that has
  // not been through the spine. The hashing is unchanged (lowercased,
  // trimmed, sha256), which is what keeps the value comparable to the ids
  // Meta already holds for this account.
  const externalIdSource = normalized.identity.canonical_customer_id ?? normalized.identity.user_id;
  if (externalIdSource !== null) {
    userData.external_id = [sha256Hex(externalIdSource.toLowerCase().trim())];
  }
  if (normalized.identity.anonymous_id !== null) {
    userData.anon_id = sha256Hex(normalized.identity.anonymous_id);
  }

  // Browser-side tracking cookies — Meta documents these as
  // `fbp` and `fbc`. The shared normalize layer doesn't yet flatten
  // them out of `properties`; the per-vendor mapper reads them from
  // the (normalized) properties bag when present.
  // (NormalizedEvent doesn't carry properties on the context block;
  // we'd read from normalized.properties if a future producer puts
  // them there.)
  if (normalized.context.ip !== null) {
    userData.client_ip_address = normalized.context.ip;
  }
  if (normalized.context.user_agent !== null) {
    userData.client_user_agent = normalized.context.user_agent;
  }

  return userData;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildResult(
  normalized: NormalizedEvent,
  eventName: string,
  customData: CustomDataBuilder,
): MapperResult<MetaCapiPayload> {
  const payload: MetaCapiPayload = {
    event_name: eventName,
    event_time: Math.floor(normalized.occurred_at_epoch_ms / 1000),
    event_id: normalized.event_id,
    action_source: inferActionSource(normalized),
    ...(normalized.context.page_url !== null
      ? { event_source_url: normalized.context.page_url }
      : {}),
    user_data: buildUserData(normalized),
    ...(Object.keys(customData).length > 0 ? { custom_data: freezeCustom(customData) } : {}),
    ...(isMarketingDenied(normalized) ? { data_processing_options: ["LDU"] } : {}),
  };
  return { kind: "mapped", payload, dedupe_key: normalized.event_id };
}

/**
 * Cast the build-up object to the readonly `MetaCapiCustomData` shape.
 * The runtime never mutates the result so the cast is safe; the freeze
 * makes that contract enforceable in tests.
 */
function freezeCustom(customData: CustomDataBuilder): MetaCapiCustomData {
  return Object.freeze(customData) as MetaCapiCustomData;
}

/**
 * Per Meta's CCPA guidance: when the caller declares `marketing=false`,
 * we stamp `data_processing_options: ["LDU"]` (Limited Data Use). The
 * normalize layer already drops the event when `required_consent.marketing`
 * is true AND the envelope declares false, so this branch only fires
 * when a downstream destination is more permissive than the mapper.
 */
function isMarketingDenied(normalized: NormalizedEvent): boolean {
  if (normalized.consent.status !== "granted") return false;
  for (const dim of normalized.consent.dimensions) {
    if (dim.dimension === "marketing" && dim.granted === false) return true;
  }
  return false;
}

function readString(props: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = props[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function readInteger(props: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = props[key];
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) {
    return value;
  }
  return null;
}

function readArray(
  props: Readonly<Record<string, unknown>>,
  key: string,
): readonly unknown[] | null {
  const value = props[key];
  return Array.isArray(value) ? value : null;
}

function sumItemQuantities(items: readonly unknown[]): number {
  let sum = 0;
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const q = (item as Record<string, unknown>)["quantity"];
    if (typeof q === "number" && Number.isFinite(q) && Number.isInteger(q) && q > 0) {
      sum += q;
    }
  }
  return sum;
}

/**
 * Wrap `minorToMajor` to gracefully degrade on bad input rather than
 * crashing the mapper. Bad input lands as `mapped_failed` upstream
 * (Meta receives no value) but the runtime stays healthy.
 */
function safeMinorToMajor(minor: number, currency: string): number | undefined {
  try {
    return minorToMajor(minor, currency);
  } catch {
    return undefined;
  }
}
