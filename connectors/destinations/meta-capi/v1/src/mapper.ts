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
 * usually start with, plus the page view every pixel install sends:
 *
 *   - `checkout.started`      → `InitiateCheckout`
 *   - `payment.approved`      → `Purchase`
 *   - `user.identified`       → `Lead`
 *   - `signup.completed`      → `CompleteRegistration`
 *   - `subscription.renewed`  → `Subscribe`
 *   - `page.viewed`           → `PageView`
 *
 * Events outside this set are `skipped_unmapped` at the runtime layer
 * (no mapper registered).
 *
 * Action-source inference lives in `inferActionSource` and consults the
 * canonical `context.source.type` plus a light heuristic on whether the
 * page_url / user_agent slots are populated. Vendor consumers are
 * allowed to add per-mapper overrides; v1 keeps the inference uniform.
 */

import type { Mapper, MapperContext, MapperResult } from "@polaris/delivery-destinations";
import type { NormalizedEnrichment, NormalizedEvent } from "@polaris/delivery-normalize";
import {
  hasAppContext,
  minorToMajor,
  prepareIdentity,
  sha256Hex,
} from "@polaris/delivery-normalize";

import { locationFromGeoEnabled } from "./project-config.js";
import type {
  MetaActionSource,
  MetaCapiContent,
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
export const META_EVENT_PAGE_VIEW = "PageView" as const;

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
  "page.viewed": META_EVENT_PAGE_VIEW,
}) as Readonly<Record<string, string>>;

// ---------------------------------------------------------------------------
// Per-event mappers
// ---------------------------------------------------------------------------

/**
 * `checkout.started` → `InitiateCheckout`.
 *
 * Pulls `currency` + `total` (in minor units) off `properties`; converts
 * to major units for Meta's `custom_data.value` field. `num_items` is
 * derived from `items[].quantity` sum when present, and the cart lines
 * themselves land in `contents[]` / `content_ids[]`.
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
    applyContents(customData, items, currency);
  }
  const cartId = readString(props, "cart_id");
  if (cartId !== null) customData.order_id = cartId;

  return buildResult(ctx, META_EVENT_INITIATE_CHECKOUT, customData);
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
  // The purchased lines, when the payment carries them. `num_items` is
  // deliberately NOT derived here: Purchase has never sent one, and a
  // count appearing on historical events the day this ships would be a
  // change to a reported number nobody asked for.
  const items = readArray(props, "items");
  if (items !== null) applyContents(customData, items, currency);
  const orderId = readString(props, "order_id") ?? readString(props, "transaction_id");
  if (orderId !== null) customData.order_id = orderId;

  return buildResult(ctx, META_EVENT_PURCHASE, customData);
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
  return buildResult(ctx, META_EVENT_LEAD, {});
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

  return buildResult(ctx, META_EVENT_COMPLETE_REGISTRATION, customData);
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

  return buildResult(ctx, META_EVENT_SUBSCRIBE, customData);
};

/**
 * `page.viewed` → `PageView`.
 *
 * The event every Meta pixel install sends, and the one this connector
 * had no mapper for — a browser running the pixel reported page views and
 * the server-side stream did not, so the two channels disagreed about the
 * top of every funnel and Meta had nothing to deduplicate the pixel's
 * `PageView` against.
 *
 * No `custom_data`. A page view has no cart, no value and no order, and
 * Meta reads an empty `custom_data` object as a claim about the event
 * rather than as silence. The URL is not lost by that: it rides
 * `event_source_url`, which `buildResult` fills from `context.page_url`
 * for every event that has one.
 *
 * Consent is unchanged and still `marketing: true` for the whole
 * destination — a page view delivered to an ad platform is advertising
 * data whatever the vendor calls it.
 */
export const pageViewedMapper: Mapper<MetaCapiPayload> = (
  ctx: MapperContext,
): MapperResult<MetaCapiPayload> => {
  return buildResult(ctx, META_EVENT_PAGE_VIEW, {});
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
 * Every hashed field is read from `normalized.identity`, never computed
 * here: the digests have to be the same ones TikTok, Reddit and Snap
 * receive for the same person, and one canonicalization rule per field
 * lives in `@polaris/delivery-normalize`. Raw fields (`client_ip_address`,
 * `client_user_agent`) pass through unchanged.
 *
 * `options.locationFromGeo` is the per-instance switch described in
 * `project-config.ts`. It only ever fills a slot the person's traits left
 * empty; see `geoMatchKeys`.
 */
export function buildUserData(
  normalized: NormalizedEvent,
  options: { readonly locationFromGeo?: boolean } = {},
): MetaCapiUserData {
  const identity = normalized.identity;
  const userData: {
    em?: string[];
    ph?: string[];
    external_id?: string[];
    fn?: string[];
    ln?: string[];
    ge?: string[];
    db?: string[];
    ct?: string[];
    st?: string[];
    zp?: string[];
    country?: string[];
    fbp?: string;
    fbc?: string;
    client_ip_address?: string;
    client_user_agent?: string;
    anon_id?: string;
  } = {};

  if (identity.email_sha256 !== null) {
    userData.em = [identity.email_sha256];
  }
  if (identity.phone_sha256 !== null) {
    userData.ph = [identity.phone_sha256];
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
  const externalIdSource = identity.canonical_customer_id ?? identity.user_id;
  if (externalIdSource !== null) {
    userData.external_id = [sha256Hex(externalIdSource.toLowerCase().trim())];
  }

  // The eight further customer-information parameters, each straight off
  // the prepared identity. Meta's `ge` and `db` take the person half,
  // `ct` / `st` / `zp` / `country` the address half; a slot the normalize
  // layer refused (a country it could not resolve to ISO-3166, a gender
  // outside `m`/`f`) is `null` there and simply not sent, which is the
  // honest outcome — a wrong match key is matched against somebody else.
  const geo = options.locationFromGeo === true ? geoMatchKeys(normalized.enrichment) : null;
  putHashed(userData, "fn", identity.first_name_sha256);
  putHashed(userData, "ln", identity.last_name_sha256);
  putHashed(userData, "ge", identity.gender_sha256);
  putHashed(userData, "db", identity.birthday_sha256);
  // Traits first, geo only where they are silent. The fallback never
  // reaches `zp`: geo resolves an address to a city, and there is no
  // postal code in it to fall back to.
  putHashed(userData, "ct", identity.city_sha256 ?? geo?.city_sha256);
  putHashed(userData, "st", identity.state_sha256 ?? geo?.state_sha256);
  putHashed(userData, "zp", identity.postal_code_sha256);
  putHashed(userData, "country", identity.country_sha256 ?? geo?.country_sha256);

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

  // App events only, per Meta's customer-information reference: of
  // `anon_id` it says "This parameter is for app events only", and gives
  // it no definition for a website event. It used to go on every payload,
  // which put a field Meta does not read for that action_source on the
  // majority of this connector's traffic.
  //
  // https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters/
  if (identity.anonymous_id !== null && inferActionSource(normalized) === "app") {
    userData.anon_id = sha256Hex(identity.anonymous_id);
  }

  return userData;
}

/**
 * Hash `enrichment.geo` into the address match keys, through the same
 * `prepareIdentity` that produced the trait-fed ones.
 *
 * Going back through the normalize layer rather than hashing here is what
 * makes the fallback comparable: a person whose traits carry
 * `"São Paulo"` and a person geolocated to `"São Paulo"` must produce one
 * digest, and they only do if both went through `canonicalizePlaceName`.
 * It is also what makes `country` safe — geo answers with an ISO alpha-2
 * code, and the same canonicalizer that accepts it would refuse a string
 * it cannot resolve rather than hash a guess.
 *
 * `region` is Meta's `st`. `postal_code` is not passed, because geo has
 * none.
 */
function geoMatchKeys(enrichment: NormalizedEnrichment): {
  readonly city_sha256: string | null;
  readonly state_sha256: string | null;
  readonly country_sha256: string | null;
} | null {
  const geo = enrichment.geo;
  if (geo === null) return null;
  const prepared = prepareIdentity(
    { city: geo.city, state: geo.region, country: geo.country },
    // Meta takes hashed PII and nothing else, which is what the connector
    // declares to the normalize stage in `IDENTITY_HASHING`. Saying so
    // again here is what keeps `prepareIdentity` off the plaintext slots.
    { email: true },
  );
  return {
    city_sha256: prepared.city_sha256 ?? null,
    state_sha256: prepared.state_sha256 ?? null,
    country_sha256: prepared.country_sha256 ?? null,
  };
}

/**
 * Put one hashed match key on the block, as the single-entry array Meta
 * takes, and leave the slot absent when there is no digest.
 *
 * `undefined` and `null` are the same answer here on purpose: the first is
 * a `PreparedIdentity` built by a test fixture that did not enumerate the
 * extended set, the second is production's "absent, or refused by the
 * field's rule", and both mean do not send this field.
 */
function putHashed(
  target: Record<string, string[] | string | undefined>,
  field: string,
  digest: string | null | undefined,
): void {
  if (digest !== null && digest !== undefined) target[field] = [digest];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Assemble the payload every per-event mapper returns.
 *
 * Takes the whole `MapperContext` rather than just the normalized event
 * because `user_data` now depends on the destination instance too: the
 * geo-fallback switch rides `instance.config`, the narrow half of the
 * configuration precedence chain, and the mapper is handed that bag and
 * no other.
 */
function buildResult(
  ctx: MapperContext,
  eventName: string,
  customData: CustomDataBuilder,
): MapperResult<MetaCapiPayload> {
  const normalized = ctx.normalized;
  const payload: MetaCapiPayload = {
    event_name: eventName,
    event_time: Math.floor(normalized.occurred_at_epoch_ms / 1000),
    event_id: normalized.event_id,
    action_source: inferActionSource(normalized),
    ...(normalized.context.page_url !== null
      ? { event_source_url: normalized.context.page_url }
      : {}),
    user_data: buildUserData(normalized, {
      locationFromGeo: locationFromGeoEnabled(ctx.instance.config),
    }),
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
 * Put the cart on `custom_data`: `contents[]`, `content_ids[]` and the
 * `content_type` that says what those ids name.
 *
 * The three land together or not at all. A `content_ids` with no
 * `content_type` is an id list Meta cannot join to a catalogue, and a
 * `content_type` with no ids is a claim about nothing — so an `items[]`
 * whose every line is unreadable leaves `custom_data` exactly as it was.
 *
 * The item-shape tolerance is GA4's and TikTok's, field for field: the
 * vendor's own id key first and `sku` behind it, a `quantity` that must be
 * a positive integer, and a `unit_price` in minor units converted with the
 * parent event's currency. It is written out here rather than shared with
 * them because the three builders agree on how to READ a line and disagree
 * on what to emit — GA4 wants `item_id`/`item_name`/`price`, TikTok
 * `content_id`/`content_name`/`price`, Meta `id`/`item_price` and no name
 * slot at all. A shared reader would have to return a fourth shape that
 * all three then rename, which is more moving parts than the duplication
 * costs.
 *
 * The id key read ahead of `sku` is `content_id` — TikTok's spelling, not
 * a third one. Both vendors mean the same thing by it, the id this line
 * carries in the advertiser's product catalogue, and a producer who set it
 * for one ad platform meant it for the other.
 */
function applyContents(
  customData: CustomDataBuilder,
  items: readonly unknown[],
  currency: string | null,
): void {
  const contents: MetaCapiContent[] = [];
  const contentIds: string[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    const entry: { id?: string; quantity?: number; item_price?: number } = {};
    const sku = obj["sku"];
    const id = obj["content_id"] ?? sku;
    if (typeof id === "string" && id.length > 0) {
      entry.id = id;
      contentIds.push(id);
    }
    const q = obj["quantity"];
    if (typeof q === "number" && Number.isFinite(q) && Number.isInteger(q) && q > 0) {
      entry.quantity = q;
    }
    const unitPrice = obj["unit_price"];
    if (
      typeof unitPrice === "number" &&
      Number.isFinite(unitPrice) &&
      Number.isInteger(unitPrice) &&
      currency !== null
    ) {
      const price = safeMinorToMajor(unitPrice, currency);
      if (price !== undefined) entry.item_price = price;
    }
    if (Object.keys(entry).length > 0) contents.push(Object.freeze(entry));
  }
  if (contents.length === 0) return;
  customData.contents = Object.freeze(contents);
  if (contentIds.length > 0) {
    customData.content_ids = Object.freeze(contentIds);
    // `product`, never `product_group`: the ids above are cart-line SKUs,
    // and calling them groups would point Meta's catalogue join at a
    // parent that does not exist.
    customData.content_type = "product";
  }
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
