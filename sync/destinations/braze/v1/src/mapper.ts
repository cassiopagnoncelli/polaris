/**
 * Braze REST API v1 mappers.
 *
 * Per `docs/architecture/06-destinations.md`, the mapper is the MAP stage
 * of the destination pipeline. It is pure: no I/O, no clock, no PII reach
 * (the `MapperContext` doesn't carry the raw envelope).
 *
 * Each per-canonical-event mapper produces a `BrazePayload` populated
 * with exactly one of `attributes[]`, `events[]`, `purchases[]`. The
 * deliverer wraps the payload directly into `{ attributes?, events?,
 * purchases? }` on the wire and POSTs to `rest.<instance>.braze.com/users/track`.
 *
 * v1 covers the lifecycle subset that production Braze integrations
 * usually start with:
 *
 *   - `checkout.started`  → `events[]` entry, name='checkout_started'
 *   - `payment.approved`  → `purchases[]` entry
 *   - `user.identified`   → `attributes[]` entry (creates the user
 *                            profile via `_update_existing_only=false`)
 *
 * Events outside this set produce `mapped_failed` records at the
 * runtime layer (no mapper registered).
 *
 * Vendor dedupe: Braze does NOT provide a generic event dedupe key —
 * its REST contract accepts and re-records duplicate `events[]` entries
 * with the same `(external_id, name, time)` tuple. Polaris-side
 * delivery-key idempotency in `@polaris/shared-destinations` is the
 * canonical guard against double-delivery; see `sync/destinations/braze/v1/SPEC.md`
 * "Known divergences from canonical" for the full discussion. The
 * mapper still emits the canonical `event_id` as `dedupe_key` on the
 * `MapperResult` so the destination runtime stamps it onto the
 * `delivery_records` row for receiver-side audit, but Braze itself
 * makes no use of the field.
 */

import type { NormalizedEvent } from "@polaris/shared-destination-normalize";
import { hasAppContext, minorToMajor } from "@polaris/shared-destination-normalize";
import type { Mapper, MapperContext, MapperResult } from "@polaris/shared-destinations";

import type {
  BrazeAttributeObject,
  BrazeEventObject,
  BrazeEventProperties,
  BrazePayload,
  BrazePurchaseObject,
} from "./types.js";

/**
 * Mutable build-up shape for `BrazeEventProperties`. The mapper
 * assembles it field-by-field and the helper that constructs the event
 * spreads it through `Object.keys(...)` so the wire object only carries
 * fields the mapper actually populated.
 */
type PropertiesBuilder = {
  -readonly [K in keyof BrazeEventProperties]: BrazeEventProperties[K];
};

// ---------------------------------------------------------------------------
// Braze event name constants
// ---------------------------------------------------------------------------

/**
 * Braze custom event names emitted by v1. The `_` separator + lowercase
 * form follows Braze's own naming guidance for custom events; the
 * `purchases[]` and `attributes[]` arrays do NOT carry a `name` slot
 * (Braze handles the family identity implicitly).
 */
export const BRAZE_EVENT_CHECKOUT_STARTED = "checkout_started" as const;

/**
 * Closed-set mapping from canonical event name → Braze wire family. The
 * descriptor uses this map as the keys for the per-event `MapperMap`.
 * Tests pin it so a future contributor cannot widen the matrix without
 * the goldens flagging.
 */
export const CANONICAL_TO_BRAZE_FAMILY = Object.freeze({
  "checkout.started": "events",
  "payment.approved": "purchases",
  "user.identified": "attributes",
}) as Readonly<Record<string, "events" | "purchases" | "attributes">>;

// ---------------------------------------------------------------------------
// Per-event mappers
// ---------------------------------------------------------------------------

/**
 * `checkout.started` → `events[]` entry with `name='checkout_started'`.
 *
 * Pulls `currency` + `total` (in minor units) off `properties`; converts
 * to major units for Braze's `properties.value` field. Braze treats
 * custom-event properties as free-form key/value pairs; v1 emits a
 * narrow well-known slot set (currency, value, cart_id, page_url,
 * num_items) so the wire shape is predictable per canonical event.
 *
 * Emits a `skip` outcome when no `external_id` can be derived from the
 * normalized identity — Braze rejects `events[]` entries without an
 * external/braze identifier and a `skip` is cheaper than letting the
 * vendor return 400.
 */
export const checkoutStartedMapper: Mapper<BrazePayload> = (
  ctx: MapperContext,
): MapperResult<BrazePayload> => {
  const identifier = resolveBrazeIdentifier(ctx.normalized);
  if (identifier === null) {
    return { kind: "skip", reason: "no_identifier_for_braze_event" };
  }

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
  const cartId = readString(props, "cart_id");
  if (cartId !== null) properties.cart_id = cartId;
  if (items !== null) {
    const numItems = sumItemQuantities(items);
    if (numItems > 0) properties.num_items = numItems;
  }
  if (ctx.normalized.context.page_url !== null) {
    properties.page_url = ctx.normalized.context.page_url;
  }

  const eventBuilder = applyBrazeIdentifier(
    {
      name: BRAZE_EVENT_CHECKOUT_STARTED,
      time: ctx.normalized.occurred_at,
      ...(Object.keys(properties).length > 0 ? { properties: freezeProperties(properties) } : {}),
    },
    identifier,
  );
  attachDeviceIdIfApp(eventBuilder, identifier, ctx.normalized);
  const event = eventBuilder as BrazeEventObject;
  const payload: BrazePayload = { events: Object.freeze([Object.freeze(event)]) };
  return { kind: "mapped", payload, dedupe_key: ctx.normalized.event_id };
};

/**
 * `payment.approved` → `purchases[]` entry.
 *
 * Braze's purchase family feeds revenue attribution + lifetime value
 * computations differently from custom events. Each `purchases[]` entry
 * carries a required `product_id`, `currency`, `price`, `time`; v1
 * derives `product_id` from `cart_id` (preferred) or `order_id` /
 * `transaction_id` (fallback) — Braze's documentation explicitly notes
 * that a single purchase record per transaction is acceptable when a
 * per-line-item breakdown is not available.
 *
 * Emits a `skip` outcome when:
 *
 *   - no `external_id` can be derived (Braze rejects unbound purchases), or
 *   - no `currency` + `amount_minor`/`amount` pair is available (Braze
 *     requires both `price` and `currency` on every purchase entry), or
 *   - no `product_id` can be derived from `cart_id` / `order_id` /
 *     `transaction_id` (Braze requires the slot).
 *
 * `dedupe_key` is the canonical `event_id` for `delivery_records` audit
 * — Braze does not consult the field for purchase dedupe.
 */
export const paymentApprovedMapper: Mapper<BrazePayload> = (
  ctx: MapperContext,
): MapperResult<BrazePayload> => {
  const identifier = resolveBrazeIdentifier(ctx.normalized);
  if (identifier === null) {
    return { kind: "skip", reason: "no_identifier_for_braze_purchase" };
  }

  const props = ctx.normalized.properties;
  const currency = readString(props, "currency");
  const amountMinor = readInteger(props, "amount_minor") ?? readInteger(props, "amount");
  if (currency === null || amountMinor === null) {
    return { kind: "skip", reason: "missing_currency_or_amount_for_braze_purchase" };
  }
  const price = safeMinorToMajor(amountMinor, currency);
  if (price === undefined) {
    return { kind: "skip", reason: "unsupported_currency_for_braze_purchase" };
  }

  const productId =
    readString(props, "cart_id") ??
    readString(props, "order_id") ??
    readString(props, "transaction_id");
  if (productId === null) {
    return { kind: "skip", reason: "no_product_id_for_braze_purchase" };
  }

  const purchaseBuilder = applyBrazeIdentifier(
    {
      product_id: productId,
      currency,
      price,
      time: ctx.normalized.occurred_at,
    },
    identifier,
  );
  attachDeviceIdIfApp(purchaseBuilder, identifier, ctx.normalized);
  const purchase = purchaseBuilder as BrazePurchaseObject;
  const payload: BrazePayload = { purchases: Object.freeze([Object.freeze(purchase)]) };
  return { kind: "mapped", payload, dedupe_key: ctx.normalized.event_id };
};

/**
 * `user.identified` → `attributes[]` entry.
 *
 * First-touch identification: Braze creates the user profile when one
 * doesn't already exist (`_update_existing_only=false`), then writes
 * the documented identifier slots (email, phone) and locale-related
 * passthrough fields. Custom-attribute slots beyond the well-known set
 * are NOT mapped in v1 — a future minor may surface a hook on the
 * descriptor for per-receiver attribute synthesis.
 *
 * Emits a `skip` when no `external_id` can be derived; Braze's
 * `attributes[]` entries require either `external_id`, `braze_id`, or
 * `user_alias` and v1 only emits `external_id`-keyed entries.
 */
export const userIdentifiedMapper: Mapper<BrazePayload> = (
  ctx: MapperContext,
): MapperResult<BrazePayload> => {
  const identifier = resolveBrazeIdentifier(ctx.normalized);
  if (identifier === null) {
    return { kind: "skip", reason: "no_identifier_for_braze_attribute" };
  }

  const attribute: {
    external_id?: string;
    user_alias?: { alias_label: string; alias_name: string };
    device_id?: string;
    email?: string;
    phone?: string;
    _update_existing_only: boolean;
    country?: string;
    language?: string;
  } = {
    _update_existing_only: false,
  };
  applyBrazeIdentifier(attribute, identifier);
  if (ctx.normalized.identity.email !== null) {
    attribute.email = ctx.normalized.identity.email;
  }
  if (ctx.normalized.identity.phone !== null) {
    attribute.phone = ctx.normalized.identity.phone;
  }
  if (ctx.normalized.context.locale !== null) {
    attribute.language = ctx.normalized.context.locale;
  }

  attachDeviceIdIfApp(attribute, identifier, ctx.normalized);
  const frozen = Object.freeze(attribute) as BrazeAttributeObject;
  const payload: BrazePayload = { attributes: Object.freeze([frozen]) };
  return { kind: "mapped", payload, dedupe_key: ctx.normalized.event_id };
};

// ---------------------------------------------------------------------------
// External ID resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the Braze `external_id` from the normalized identity. Order:
 *
 *   1. `identity.user_id`  — canonical `customer_id`
 *   2. `identity.anonymous_id`  — surfaces unauthenticated events under
 *      a stable anonymous identifier (Braze accepts non-prefixed strings)
 *
 * Returns `null` when neither slot is populated. The normalize layer
 * drops events that have no usable identity at all
 * (`no_usable_identity`), so this branch only fires for events where
 * the only usable identity was email/phone — Braze does not key on
 * email/phone in v1 (a future minor may add a `user_alias` mapping).
 *
 * Lowercased + trimmed for Braze's case-insensitive identifier
 * comparison (matches Braze's documented behavior).
 */
export function resolveExternalId(normalized: NormalizedEvent): string | null {
  const userId = normalized.identity.user_id;
  if (userId !== null) {
    const trimmed = userId.trim().toLowerCase();
    if (trimmed.length > 0) return trimmed;
  }
  const anonymousId = normalized.identity.anonymous_id;
  if (anonymousId !== null) {
    const trimmed = anonymousId.trim().toLowerCase();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

/**
 * Braze `user_alias` for email-only / phone-only identities (BJPQSPE5).
 *
 * Order:
 *
 *   1. `identity.email`  → `{ alias_label: "email", alias_name: ... }`
 *   2. `identity.phone`  → `{ alias_label: "phone", alias_name: ... }`
 *
 * Email is preferred over phone because Braze recommends a stable
 * alias label per profile, and email is more likely to be canonical
 * for a given user across devices. The raw (unhashed) email/phone is
 * shipped — Braze does not accept hashed alias names. The normalize
 * layer still emits the hashed identifiers (`email_sha256` /
 * `phone_sha256`) on the envelope; this consumer reads the raw
 * `email` / `phone` slot, which is preserved through normalization
 * for vendors that key on raw values.
 */
export function resolveUserAlias(
  normalized: NormalizedEvent,
): { alias_label: string; alias_name: string } | null {
  const email = normalized.identity.email;
  if (email !== null) {
    const trimmed = email.trim().toLowerCase();
    if (trimmed.length > 0) return { alias_label: "email", alias_name: trimmed };
  }
  const phone = normalized.identity.phone;
  if (phone !== null) {
    const trimmed = phone.trim();
    if (trimmed.length > 0) return { alias_label: "phone", alias_name: trimmed };
  }
  return null;
}

type BrazeIdentifier =
  | { kind: "external_id"; value: string }
  | { kind: "user_alias"; value: { alias_label: string; alias_name: string } }
  | { kind: "device_id"; value: string };

/**
 * Helper used by every per-event mapper: a deterministic identifier
 * record carrying ONE of `external_id`, `user_alias`, or `device_id`.
 * Braze rejects entries that carry both `external_id` and `user_alias`;
 * `device_id` is the app-channel anonymous fallback when neither
 * resolves (5UCTHNCR). The mapper picks the highest-precedence kind:
 *
 *   external_id (canonical customer_id → anonymous_id)
 *     ↳ user_alias (canonical email → phone)
 *       ↳ device_id (canonical app_idfv → app_gaid → app_idfa) — only
 *         considered when the canonical envelope is app-source.
 *
 * Returns `null` when no slot resolves — the mapper then emits `skip`.
 */
function resolveBrazeIdentifier(normalized: NormalizedEvent): BrazeIdentifier | null {
  const externalId = resolveExternalId(normalized);
  if (externalId !== null) return { kind: "external_id", value: externalId };
  const alias = resolveUserAlias(normalized);
  if (alias !== null) return { kind: "user_alias", value: alias };
  const deviceId = resolveDeviceId(normalized);
  if (deviceId !== null) return { kind: "device_id", value: deviceId };
  return null;
}

function applyBrazeIdentifier<T extends Record<string, unknown>>(
  target: T,
  identifier: BrazeIdentifier,
): T {
  if (identifier.kind === "external_id") {
    (target as Record<string, unknown>)["external_id"] = identifier.value;
  } else if (identifier.kind === "user_alias") {
    (target as Record<string, unknown>)["user_alias"] = identifier.value;
  } else {
    (target as Record<string, unknown>)["device_id"] = identifier.value;
  }
  return target;
}

/**
 * Resolve the Braze `device_id` from the canonical envelope's app
 * context (5UCTHNCR). Order:
 *
 *   1. `context.app_idfv`  — iOS Vendor Identifier (UUID; Braze's
 *                            documented preferred mobile id)
 *   2. `context.app_gaid`  — Android Advertising Id
 *   3. `context.app_idfa`  — iOS Advertising Id; fallback for
 *                            integrations that don't surface IDFV
 *
 * Returns `null` when the envelope carries no app context. Lowercasing
 * is left to the receiver — Braze treats the slot as opaque.
 */
export function resolveDeviceId(normalized: NormalizedEvent): string | null {
  if (!hasAppContext(normalized.context)) return null;
  return (
    normalized.context.app_idfv ??
    normalized.context.app_gaid ??
    normalized.context.app_idfa ??
    null
  );
}

/**
 * Attach `device_id` to an entry when the canonical envelope is
 * app-source AND a device id is resolvable. Skipped when the primary
 * identifier IS already `device_id` (the slot is set during
 * `applyBrazeIdentifier`) and when there is no app context. Called
 * AFTER `applyBrazeIdentifier` so the additive device_id rides
 * alongside `external_id` / `user_alias` for logged-in mobile users —
 * Braze stitches the anonymous device session to the identified
 * profile when both are present.
 */
function attachDeviceIdIfApp<T extends Record<string, unknown>>(
  target: T,
  identifier: BrazeIdentifier,
  normalized: NormalizedEvent,
): T {
  if (identifier.kind === "device_id") return target;
  const deviceId = resolveDeviceId(normalized);
  if (deviceId === null) return target;
  (target as Record<string, unknown>)["device_id"] = deviceId;
  return target;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Cast the build-up object to the readonly `BrazeEventProperties` shape.
 * The runtime never mutates the result so the cast is safe; the freeze
 * makes that contract enforceable in tests.
 */
function freezeProperties(properties: PropertiesBuilder): BrazeEventProperties {
  return Object.freeze(properties) as BrazeEventProperties;
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
 * (Braze receives no value) but the runtime stays healthy.
 */
function safeMinorToMajor(minor: number, currency: string): number | undefined {
  try {
    return minorToMajor(minor, currency);
  } catch {
    return undefined;
  }
}
