/**
 * GA4 Measurement Protocol v1 mappers.
 *
 * Per `docs/architecture/06-destinations.md`, the mapper is the MAP stage
 * of the destination pipeline. It is pure: no I/O, no clock, no PII reach
 * (the `MapperContext` doesn't carry the raw envelope).
 *
 * Each per-canonical-event mapper produces a `Ga4EventPayload` matching
 * one entry inside the GA4 request body's `events[]` array. For
 * `payment.approved` (the `purchase` GA4 event), vendor dedupe keys on
 * the canonical `properties.transaction_id` / `order_id` so GA4
 * deduplicates cross-channel attempts against the same purchase (e.g.
 * browser gtag firing alongside the server-side Measurement Protocol).
 * For `checkout.started` and `user.identified` the canonical `event_id`
 * is used as the dedupe key — GA4 has no universal cross-event dedupe
 * outside `purchase`, so v1 is conservative and only promises dedupe
 * stability for purchases.
 *
 * v1 covers the commerce subset that production GA4 integrations
 * usually start with:
 *
 *   - `checkout.started`  → `begin_checkout`
 *   - `payment.approved`  → `purchase`
 *   - `user.identified`   → `login` (method='polaris')
 *
 * Events outside this set produce `mapped_failed` records at the
 * runtime layer (no mapper registered).
 */

import { minorToMajor } from "@polaris/shared-destination-normalize";
import type { Mapper, MapperContext, MapperResult } from "@polaris/shared-destinations";

import type { Ga4EventItem, Ga4EventParams, Ga4EventPayload } from "./types.js";

/**
 * Mutable build-up shape for `Ga4EventParams`. The mapper assembles it
 * field-by-field and the helper that constructs the `Ga4EventPayload`
 * spreads it through `Object.keys(...)` so the wire object only carries
 * fields the mapper actually populated.
 */
type ParamsBuilder = {
  -readonly [K in keyof Ga4EventParams]: Ga4EventParams[K];
};

// ---------------------------------------------------------------------------
// GA4 event name constants
// ---------------------------------------------------------------------------

export const GA4_EVENT_PURCHASE = "purchase" as const;
export const GA4_EVENT_BEGIN_CHECKOUT = "begin_checkout" as const;
export const GA4_EVENT_LOGIN = "login" as const;

/**
 * GA4 `login.method` value the v1 mapper stamps on `user.identified`.
 * Keeps the canonical identity-emission source labeled so GA4 reports
 * can split out Polaris-driven logins from organic gtag logins.
 */
export const GA4_LOGIN_METHOD_POLARIS = "polaris" as const;

/**
 * Closed-set mapping from canonical event name → GA4 event name. The
 * descriptor uses this map as the keys for the per-event `MapperMap`.
 */
export const CANONICAL_TO_GA4_EVENT = Object.freeze({
  "checkout.started": GA4_EVENT_BEGIN_CHECKOUT,
  "payment.approved": GA4_EVENT_PURCHASE,
  "user.identified": GA4_EVENT_LOGIN,
}) as Readonly<Record<string, string>>;

// ---------------------------------------------------------------------------
// Per-event mappers
// ---------------------------------------------------------------------------

/**
 * `checkout.started` → `begin_checkout`.
 *
 * Pulls `currency` + `total` (in minor units) off `properties`; converts
 * to major units for GA4's `params.value` field. Per-item details land
 * in `params.items[]`.
 */
export const checkoutStartedMapper: Mapper<Ga4EventPayload> = (
  ctx: MapperContext,
): MapperResult<Ga4EventPayload> => {
  const props = ctx.normalized.properties;
  const currency = readString(props, "currency");
  const totalMinor = readInteger(props, "total");
  const items = readArray(props, "items");

  const params: ParamsBuilder = {};
  if (currency !== null && totalMinor !== null) {
    params.currency = currency;
    const value = safeMinorToMajor(totalMinor, currency);
    if (value !== undefined) params.value = value;
  } else if (currency !== null) {
    params.currency = currency;
  }
  if (items !== null) {
    const ga4Items = buildItems(items, currency);
    if (ga4Items.length > 0) params.items = ga4Items;
  }

  // `begin_checkout` has no documented vendor dedupe slot — GA4 doesn't
  // dedupe checkout events the way it dedupes purchases. We still
  // surface the canonical `event_id` as the Polaris-side dedupe_key
  // (which gets stamped on `delivery_records.dedupe_key`) so operators
  // have a stable Polaris-side handle when triaging duplicate
  // deliveries inside Polaris; on the GA4 side the event just lands.
  return buildResult(GA4_EVENT_BEGIN_CHECKOUT, params, ctx.normalized.event_id);
};

/**
 * `payment.approved` → `purchase`.
 *
 * Pulls `amount_minor` (or `amount`) / `currency` / `transaction_id`
 * (or `order_id`) off `properties`. GA4's `purchase` event dedupes on
 * `params.transaction_id` — when the canonical event carries
 * `transaction_id` (preferred) or `order_id`, the mapper stamps it on
 * the wire payload AND uses it as the Polaris-side `dedupe_key`. This
 * is the only mapping where v1 promises cross-channel purchase dedupe.
 * When neither slot is present the mapper falls back to canonical
 * `event_id` for the Polaris-side dedupe key; GA4 will not dedupe
 * cross-channel in that case.
 */
export const paymentApprovedMapper: Mapper<Ga4EventPayload> = (
  ctx: MapperContext,
): MapperResult<Ga4EventPayload> => {
  const props = ctx.normalized.properties;
  const currency = readString(props, "currency");
  const amountMinor = readInteger(props, "amount_minor") ?? readInteger(props, "amount");
  const params: ParamsBuilder = {};
  if (currency !== null && amountMinor !== null) {
    params.currency = currency;
    const value = safeMinorToMajor(amountMinor, currency);
    if (value !== undefined) params.value = value;
  } else if (currency !== null) {
    params.currency = currency;
  }
  const transactionId = readString(props, "transaction_id") ?? readString(props, "order_id");
  if (transactionId !== null) params.transaction_id = transactionId;

  const dedupeKey = transactionId ?? ctx.normalized.event_id;
  return buildResult(GA4_EVENT_PURCHASE, params, dedupeKey);
};

/**
 * `user.identified` → `login` (method=`polaris`).
 *
 * Lightweight identity-emission signal GA4 uses to associate the
 * `user_id` with the current `client_id`. Properties carry only the
 * `method` label so GA4 reports can split Polaris logins out from
 * organic gtag logins.
 */
export const userIdentifiedMapper: Mapper<Ga4EventPayload> = (
  ctx: MapperContext,
): MapperResult<Ga4EventPayload> => {
  const params: ParamsBuilder = { method: GA4_LOGIN_METHOD_POLARIS };
  return buildResult(GA4_EVENT_LOGIN, params, ctx.normalized.event_id);
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildResult(
  eventName: string,
  params: ParamsBuilder,
  dedupeKey: string,
): MapperResult<Ga4EventPayload> {
  const payload: Ga4EventPayload = {
    name: eventName,
    ...(Object.keys(params).length > 0 ? { params: freezeParams(params) } : {}),
  };
  return { kind: "mapped", payload, dedupe_key: dedupeKey };
}

/**
 * Cast the build-up object to the readonly `Ga4EventParams` shape.
 * The runtime never mutates the result so the cast is safe; the freeze
 * makes that contract enforceable in tests.
 */
function freezeParams(params: ParamsBuilder): Ga4EventParams {
  return Object.freeze(params) as Ga4EventParams;
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

/**
 * Build GA4's `params.items[]` from canonical `properties.items[]`. One
 * entry per cart line with `item_id` / `item_name` / `quantity` /
 * `price`. Price is converted from minor → major using the same
 * currency the parent event uses; failures degrade gracefully (the
 * entry is emitted without `price`).
 */
function buildItems(items: readonly unknown[], currency: string | null): readonly Ga4EventItem[] {
  const out: Ga4EventItem[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    const entry: {
      item_id?: string;
      item_name?: string;
      quantity?: number;
      price?: number;
    } = {};
    const sku = obj["sku"];
    const id = obj["item_id"] ?? sku;
    if (typeof id === "string" && id.length > 0) entry.item_id = id;
    const name = obj["name"];
    if (typeof name === "string" && name.length > 0) entry.item_name = name;
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
 * (GA4 receives no value) but the runtime stays healthy.
 */
function safeMinorToMajor(minor: number, currency: string): number | undefined {
  try {
    return minorToMajor(minor, currency);
  } catch {
    return undefined;
  }
}
