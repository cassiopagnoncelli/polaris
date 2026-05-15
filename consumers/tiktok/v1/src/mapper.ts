/**
 * TikTok Events API v1 mappers.
 *
 * Per `docs/architecture/06-destinations.md`, the mapper is the MAP stage
 * of the destination pipeline. It is pure: no I/O, no clock, no PII reach
 * (the `MapperContext` doesn't carry the raw envelope).
 *
 * Each per-canonical-event mapper produces a `TikTokEventPayload`
 * matching one entry inside TikTok Events API's `data[]` array. Vendor
 * dedupe always keys on the canonical `event_id` so TikTok deduplicates
 * cross-channel attempts (e.g. browser pixel + server Events API for the
 * same checkout) without Polaris having to invent a vendor-specific
 * dedupe key.
 *
 * v1 covers the commerce subset that production TikTok integrations
 * usually start with:
 *
 *   - `checkout.started`  → `InitiateCheckout`
 *   - `payment.approved`  → `Purchase`
 *   - `user.identified`   → `CompleteRegistration`
 *
 * Events outside this set produce `mapped_failed` records at the
 * runtime layer (no mapper registered).
 *
 * `event_source` (web vs app vs crm) is request-level on TikTok's wire
 * shape, not per-payload. The mapper exposes `inferEventSource` so the
 * deliverer can stamp the correct enum onto the wrapper; per-event
 * overrides may land in a future minor version once `FlatContext`
 * carries app-source slots.
 */

import type { NormalizedEvent } from "@polaris/shared-destination-normalize";
import { minorToMajor, sha256Hex } from "@polaris/shared-destination-normalize";
import type { Mapper, MapperContext, MapperResult } from "@polaris/shared-destinations";

import type {
  TikTokEventContent,
  TikTokEventPayload,
  TikTokEventProperties,
  TikTokEventSource,
  TikTokUserData,
} from "./types.js";

/**
 * Mutable build-up shape for `TikTokEventProperties`. The mapper
 * assembles it field-by-field and the helper that constructs the
 * `TikTokEventPayload` spreads it through `Object.keys(...)` so the
 * wire object only carries fields the mapper actually populated.
 */
type PropertiesBuilder = {
  -readonly [K in keyof TikTokEventProperties]: TikTokEventProperties[K];
};

// ---------------------------------------------------------------------------
// TikTok event name constants
// ---------------------------------------------------------------------------

export const TIKTOK_EVENT_PURCHASE = "Purchase" as const;
export const TIKTOK_EVENT_INITIATE_CHECKOUT = "InitiateCheckout" as const;
export const TIKTOK_EVENT_COMPLETE_REGISTRATION = "CompleteRegistration" as const;

/**
 * Closed-set mapping from canonical event name → TikTok event name. The
 * descriptor uses this map as the keys for the per-event `MapperMap`.
 */
export const CANONICAL_TO_TIKTOK_EVENT = Object.freeze({
  "checkout.started": TIKTOK_EVENT_INITIATE_CHECKOUT,
  "payment.approved": TIKTOK_EVENT_PURCHASE,
  "user.identified": TIKTOK_EVENT_COMPLETE_REGISTRATION,
}) as Readonly<Record<string, string>>;

// ---------------------------------------------------------------------------
// Per-event mappers
// ---------------------------------------------------------------------------

/**
 * `checkout.started` → `InitiateCheckout`.
 *
 * Pulls `currency` + `total` (in minor units) off `properties`; converts
 * to major units for TikTok's `properties.value` field. `num_items` is
 * derived from `items[].quantity` sum when present, and per-item details
 * land in `properties.contents[]`.
 */
export const checkoutStartedMapper: Mapper<TikTokEventPayload> = (
  ctx: MapperContext,
): MapperResult<TikTokEventPayload> => {
  const props = ctx.normalized.properties;
  const currency = readString(props, "currency");
  const totalMinor = readInteger(props, "total");
  const items = readArray(props, "items");

  const properties: PropertiesBuilder = {};
  if (currency !== null && totalMinor !== null) {
    properties.currency = currency;
    const value = safeMinorToMajor(totalMinor, currency);
    if (value !== undefined) properties.value = value;
  } else if (currency !== null) {
    properties.currency = currency;
  }
  if (items !== null) {
    const numItems = sumItemQuantities(items);
    if (numItems > 0) properties.num_items = numItems;
    const contents = buildContents(items, currency);
    if (contents.length > 0) properties.contents = contents;
  }
  const cartId = readString(props, "cart_id");
  if (cartId !== null) properties.order_id = cartId;

  return buildResult(ctx.normalized, TIKTOK_EVENT_INITIATE_CHECKOUT, properties);
};

/**
 * `payment.approved` → `Purchase`.
 *
 * Pulls `amount` / `currency` / `order_id` (the payments-API shape,
 * convention from `catalog/sources/storefront/payments-api.yaml`).
 * v1 is conservative: when properties don't carry `amount_minor` +
 * `currency`, the properties block omits the `value` slot and TikTok
 * still accepts the event (it just can't compute ROAS for that row).
 */
export const paymentApprovedMapper: Mapper<TikTokEventPayload> = (
  ctx: MapperContext,
): MapperResult<TikTokEventPayload> => {
  const props = ctx.normalized.properties;
  const currency = readString(props, "currency");
  const amountMinor = readInteger(props, "amount_minor") ?? readInteger(props, "amount");
  const properties: PropertiesBuilder = {};
  if (currency !== null && amountMinor !== null) {
    properties.currency = currency;
    const value = safeMinorToMajor(amountMinor, currency);
    if (value !== undefined) properties.value = value;
  } else if (currency !== null) {
    properties.currency = currency;
  }
  const orderId = readString(props, "order_id") ?? readString(props, "transaction_id");
  if (orderId !== null) properties.order_id = orderId;

  return buildResult(ctx.normalized, TIKTOK_EVENT_PURCHASE, properties);
};

/**
 * `user.identified` → `CompleteRegistration`.
 *
 * Lightweight conversion event TikTok uses for new-account / lead
 * signals. Properties carry no value/currency by default.
 */
export const userIdentifiedMapper: Mapper<TikTokEventPayload> = (
  ctx: MapperContext,
): MapperResult<TikTokEventPayload> => {
  return buildResult(ctx.normalized, TIKTOK_EVENT_COMPLETE_REGISTRATION, {});
};

// ---------------------------------------------------------------------------
// Event source inference
// ---------------------------------------------------------------------------

/**
 * Closed-set inference of TikTok's `event_source` from canonical context.
 *
 *   - `context.page_url` populated        → `web`
 *   - otherwise                           → `crm` (TikTok's backend-event default)
 *
 * The `FlatContext` shape doesn't currently carry `app_*` slots; mobile
 * events flow through `crm` until a future normalize version surfaces
 * app-context fields. Misreporting `event_source` affects TikTok's
 * ad-attribution model, so v1 stays narrow.
 */
export function inferEventSource(normalized: NormalizedEvent): TikTokEventSource {
  if (normalized.context.page_url !== null) {
    return "web";
  }
  return "crm";
}

// ---------------------------------------------------------------------------
// User data builder
// ---------------------------------------------------------------------------

/**
 * Build TikTok's `user` block from the normalized identity + context.
 *
 * Hashed fields (email, phone, external_id) come from the shared
 * normalize layer (sha256-lowercase-trim email; sha256 of E.164 phone;
 * sha256(`customer_id`) for `external_id` when no other slot applies).
 * Raw fields (`ip`, `user_agent`, `locale`) pass through unchanged.
 * `ttp` / `ttclid` (TikTok tracking cookies) are NOT mapped in v1 — they
 * live in `properties` if the SDK passes them through, and a future
 * minor version may add a hook to flatten them into `user.ttp` /
 * `user.ttclid`.
 */
export function buildUserData(normalized: NormalizedEvent): TikTokUserData {
  const userData: {
    email?: string;
    phone?: string;
    external_id?: string;
    ip?: string;
    user_agent?: string;
    locale?: string;
  } = {};

  if (normalized.identity.email_sha256 !== null) {
    userData.email = normalized.identity.email_sha256;
  }
  if (normalized.identity.phone_sha256 !== null) {
    userData.phone = normalized.identity.phone_sha256;
  }
  if (normalized.identity.user_id !== null) {
    userData.external_id = sha256Hex(normalized.identity.user_id.toLowerCase().trim());
  }
  if (normalized.context.ip !== null) {
    userData.ip = normalized.context.ip;
  }
  if (normalized.context.user_agent !== null) {
    userData.user_agent = normalized.context.user_agent;
  }
  if (normalized.context.locale !== null) {
    userData.locale = normalized.context.locale;
  }

  return userData;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildResult(
  normalized: NormalizedEvent,
  eventName: string,
  properties: PropertiesBuilder,
): MapperResult<TikTokEventPayload> {
  const page = buildPage(normalized);
  const payload: TikTokEventPayload = {
    event: eventName,
    event_time: Math.floor(normalized.occurred_at_epoch_ms / 1000),
    event_id: normalized.event_id,
    user: buildUserData(normalized),
    ...(Object.keys(properties).length > 0 ? { properties: freezeProperties(properties) } : {}),
    ...(page !== undefined ? { page } : {}),
    ...(isMarketingDenied(normalized) ? { limited_data_use: 1 as const } : {}),
  };
  return { kind: "mapped", payload, dedupe_key: normalized.event_id };
}

/**
 * Cast the build-up object to the readonly `TikTokEventProperties` shape.
 * The runtime never mutates the result so the cast is safe; the freeze
 * makes that contract enforceable in tests.
 */
function freezeProperties(properties: PropertiesBuilder): TikTokEventProperties {
  return Object.freeze(properties) as TikTokEventProperties;
}

function buildPage(normalized: NormalizedEvent): TikTokEventPayload["page"] | undefined {
  const page: { url?: string; referrer?: string } = {};
  if (normalized.context.page_url !== null) page.url = normalized.context.page_url;
  if (normalized.context.page_referrer !== null) page.referrer = normalized.context.page_referrer;
  if (page.url === undefined && page.referrer === undefined) return undefined;
  return Object.freeze(page);
}

/**
 * Per TikTok's CCPA guidance: when the caller declares `marketing=false`,
 * we stamp `limited_data_use: 1` on the per-event payload. The
 * normalize layer already drops the event when `required_consent.
 * marketing` is true AND the envelope declares false, so this branch
 * only fires when a downstream destination is more permissive than the
 * mapper.
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
 * Build TikTok's `properties.contents[]` from canonical `properties.
 * items[]`. One entry per cart line with `content_id` / `quantity` /
 * `price`. Price is converted from minor → major using the same
 * currency the parent event uses; failures degrade gracefully (the
 * entry is emitted without `price`).
 */
function buildContents(
  items: readonly unknown[],
  currency: string | null,
): readonly TikTokEventContent[] {
  const out: TikTokEventContent[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    const entry: {
      content_id?: string;
      content_name?: string;
      quantity?: number;
      price?: number;
    } = {};
    const sku = obj["sku"];
    const id = obj["content_id"] ?? sku;
    if (typeof id === "string" && id.length > 0) entry.content_id = id;
    const name = obj["name"];
    if (typeof name === "string" && name.length > 0) entry.content_name = name;
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
      if (price !== undefined) entry.price = price;
    }
    if (Object.keys(entry).length > 0) {
      out.push(Object.freeze(entry));
    }
  }
  return Object.freeze(out);
}

/**
 * Wrap `minorToMajor` to gracefully degrade on bad input rather than
 * crashing the mapper. Bad input lands as `mapped_failed` upstream
 * (TikTok receives no value) but the runtime stays healthy.
 */
function safeMinorToMajor(minor: number, currency: string): number | undefined {
  try {
    return minorToMajor(minor, currency);
  } catch {
    return undefined;
  }
}
