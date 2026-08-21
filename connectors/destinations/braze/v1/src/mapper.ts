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
 * delivery-key idempotency in `@polaris/delivery-destinations` is the
 * canonical guard against double-delivery; see `sync/destinations/braze/v1/SPEC.md`
 * "Known divergences from canonical" for the full discussion. The
 * mapper still emits the canonical `event_id` as `dedupe_key` on the
 * `MapperResult` so the destination runtime stamps it onto the
 * `delivery_records` row for receiver-side audit, but Braze itself
 * makes no use of the field.
 */

import type { NormalizedEvent } from "@polaris/delivery-normalize";
import { hasAppContext, minorToMajor } from "@polaris/delivery-normalize";
import type {
  DestinationInstance,
  Mapper,
  MapperContext,
  MapperResult,
} from "@polaris/delivery-destinations";

import type {
  BrazeAttributeObject,
  BrazeEventObject,
  BrazeEventProperties,
  BrazeJourneyEventProperties,
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
 * The single Braze custom-event name every journey step advance carries.
 *
 * ONE name, with `journey` and `step_id` as properties — not
 * `journey_welcome_thank_repeat` per step. Braze custom-event names are a
 * bounded, billed dimension in the account, and a name minted per
 * (journey, step) would let a Polaris catalog change consume a customer's
 * Braze namespace. A campaign filters on the properties instead, which is
 * what Braze's trigger filters are for.
 */
export const BRAZE_EVENT_JOURNEY_STEP = "polaris_journey_step" as const;

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
  // Audience membership is a STATE of the user, not something that
  // happened to them, so it is an attribute rather than a custom event.
  // Braze segments on attributes directly; a custom event would make
  // "is a member" a question about event history with a recency window,
  // which is not what membership means.
  "audience.entered": "attributes",
  "audience.exited": "attributes",
  // A journey is a sequence of MOMENTS, which is the opposite of the
  // audience case above. "Reached the thank-you step" happened at a time
  // and is what a Braze campaign triggers on; membership in an audience
  // is a lasting fact you segment by. So the same file maps one to
  // attributes and the other to events, on the same reasoning.
  "journey.step_advanced": "events",
  // Entering and leaving a journey are the exception, and go back to
  // attributes: "is currently in the welcome series" is a state, and the
  // question it answers is suppression — do not send the promo to someone
  // mid-onboarding. That is a segment, not a trigger.
  "journey.entered": "attributes",
  "journey.exited": "attributes",
}) as Readonly<Record<string, "events" | "purchases" | "attributes">>;

/**
 * Prefix for the per-audience custom attribute Braze receives.
 *
 * Namespaced so an audience key can never collide with a trait
 * attribute or one of Braze's own reserved slots — `tier` is a plausible
 * audience key and also a trait this mapper already writes.
 */
export const BRAZE_AUDIENCE_ATTRIBUTE_PREFIX = "polaris_audience_" as const;

/** The attribute name a given audience writes. */
export function brazeAudienceAttribute(audience: string): string {
  return `${BRAZE_AUDIENCE_ATTRIBUTE_PREFIX}${audience}`;
}

/**
 * Prefix for the per-journey membership attribute.
 *
 * Distinct from the audience prefix so the two namespaces cannot collide:
 * an audience and a journey may legitimately share a key — `vip` is a
 * plausible name for both — and one overwriting the other would make a
 * suppression rule silently follow the wrong thing.
 */
export const BRAZE_JOURNEY_ATTRIBUTE_PREFIX = "polaris_journey_" as const;

/** The attribute name a given journey's membership writes. */
export function brazeJourneyAttribute(journey: string): string {
  return `${BRAZE_JOURNEY_ATTRIBUTE_PREFIX}${journey}`;
}

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
 * Profile traits Braze accepts as CUSTOM attributes: the trait path the
 * catalog pins, mapped to the Braze attribute name it writes.
 *
 * An ALLOWLIST, not a passthrough, and the reason is that Braze's attribute
 * space is a shared namespace an operator curates: forwarding every trait
 * would let a new field in the profile store silently create an attribute
 * in Braze, which is how a vendor account fills with junk nobody can
 * attribute to a decision. Adding a trait here is that decision.
 *
 * A map rather than the list it was, because the widening to
 * `user.identified` v1's pinned slots brought two things a list cannot
 * say. The catalog pins `company` as a nested bag, and Braze's nested
 * custom attributes are an account feature rather than a given — so
 * `company.name` is flattened to a `company_name` every workspace accepts.
 * And a flattened name is a RENAME, which is a decision that belongs
 * beside the trait it renames rather than buried in the code that applies
 * it.
 *
 * What is deliberately NOT here is anything Braze reserves. `first_name`,
 * `dob`, `home_city` and the rest are STANDARD profile fields, written
 * from the same trait snapshot by `applyStandardAttributes` — a trait
 * reaching them through this path would write a documented slot with an
 * undocumented value. `BRAZE_RESERVED_ATTRIBUTE_KEYS` enforces that
 * independently of this table, so a mistake here cannot become a profile
 * mistake.
 */
export const BRAZE_TRAIT_ATTRIBUTES: Readonly<Record<string, string>> = Object.freeze({
  // Project-defined lifecycle traits, here since MVKUP64R.
  tier: "tier",
  plan: "plan",
  lifecycle_stage: "lifecycle_stage",
  lifetime_value: "lifetime_value",
  first_purchase_at: "first_purchase_at",
  last_purchase_at: "last_purchase_at",
  total_orders: "total_orders",
  // `user.identified` v1's pinned slots that Braze does not reserve
  // (STHB0). `name` is the unsplit full name, which Braze has no standard
  // field for — it keys personalization on `first_name` / `last_name`.
  name: "name",
  title: "title",
  username: "username",
  website: "website",
  created_at: "created_at",
  "company.id": "company_id",
  "company.name": "company_name",
  "company.industry": "company_industry",
  "company.employee_count": "company_employee_count",
  "company.plan": "company_plan",
});

/**
 * Braze's own attribute names: the identifier and control slots, plus every
 * standard user-profile field the vendor documents.
 *
 * The whole published set rather than the subset this mapper happens to
 * write, and that widening is the point. A curated custom attribute that
 * collides with a Braze standard field does not fail loudly — it writes the
 * standard field, with whatever the profile store happened to hold. So the
 * guard answers "is this name Braze's?" rather than "does this mapper use
 * it?", and a slot this connector does not fill today is still one a trait
 * may never reach around it to fill.
 *
 * @see https://www.braze.com/docs/api/objects_filters/user_attributes_object
 */
const BRAZE_RESERVED_ATTRIBUTE_KEYS: readonly string[] = Object.freeze([
  // Identifier + control slots.
  "external_id",
  "user_alias",
  "braze_id",
  "device_id",
  "_update_existing_only",
  // Standard profile fields.
  "country",
  "current_location",
  "date_of_first_session",
  "date_of_last_session",
  "dob",
  "email",
  "email_click_tracking_disabled",
  "email_open_tracking_disabled",
  "email_subscribe",
  "facebook",
  "first_name",
  "gender",
  "home_city",
  "image_url",
  "language",
  "last_name",
  "marked_email_as_spam_at",
  "phone",
  "push_subscribe",
  "push_tokens",
  "subscription_groups",
  "time_zone",
  "twitter",
]);

/**
 * Per-instance switch: fill `country` and `home_city` from the geo
 * enrichment when the profile's own address does not carry them.
 *
 * OFF unless an instance asks for it, and the default is the honest one.
 * Geo is derived from the request IP, so it says where the DEVICE was, not
 * where the person lives — someone on holiday is `PT` for a week, and a
 * Braze segment written on `home_city` would move them out of a campaign
 * and back again next month. A brand that prefers approximate location to
 * none opts in per destination; nobody acquires it by upgrading.
 *
 * Read from `destinations.config` rather than `project_config`, on both
 * counts that matter: the `MapperContext` carries the instance and not the
 * project slice, and the choice belongs to one destination anyway — a
 * marketing instance may want it where the data-engineering one beside it
 * must not.
 */
export const BRAZE_LOCATION_FROM_GEO_KEY = "location_from_geo" as const;

/** Whether this instance opted in. Strictly `true`; anything else is off. */
function locationFromGeo(instance: DestinationInstance): boolean {
  return instance.config[BRAZE_LOCATION_FROM_GEO_KEY] === true;
}

/**
 * Braze's `gender` vocabulary, keyed by the canonical token normalize
 * produces.
 *
 * Braze accepts `M`, `F`, `O` (other), `N` (not applicable) and `P` (prefer
 * not to say). Only two of the five are reachable, and that is the shared
 * canonical form's decision rather than this mapper's: `person.ts` maps a
 * producer's gender onto `m` or `f` and refuses everything else, because
 * Meta's `ge` takes those two and a wrong match key is worse than a missing
 * one.
 *
 * The cost of that lands here, on the one vendor with somewhere to put the
 * rest: a profile whose gender is non-binary or withheld reaches Braze with
 * the slot omitted, where `O` or `P` would have been true. Widening it
 * means widening a vocabulary every destination reads, so it is not this
 * connector's to make.
 */
const BRAZE_GENDER_TOKENS: Readonly<Record<string, string>> = Object.freeze({
  m: "M",
  f: "F",
});

/**
 * Write Braze's standard profile fields from the trait snapshot.
 *
 * Two sources, on one distinction. NAMES and URLs are read from the trait
 * bag, which keeps the producer's spelling; CODES are read from the
 * canonical identity block, which is where the shared normalizer put the
 * one agreed form. Reading a name from the identity block would greet
 * `"O'Brien"` as `"obrien"` — that value is canonicalized for hashing, not
 * for display — and reading a code from the trait bag would make Braze the
 * one vendor that receives `"Brazil"` where the others receive `"BR"`.
 *
 * Both halves come from the same snapshot either way: `matchKeysFromTraits`
 * is what fills the identity slots this reads, so a profile with no traits
 * writes none of these fields and the attribute is exactly what it was
 * before this landed.
 */
function applyStandardAttributes(
  attribute: Record<string, unknown>,
  normalized: NormalizedEvent,
  geoFallback: boolean,
): void {
  const traits = normalized.traits;
  const firstName = readTraitString(traits, "first_name");
  if (firstName !== null) attribute["first_name"] = firstName;
  const lastName = readTraitString(traits, "last_name");
  if (lastName !== null) attribute["last_name"] = lastName;
  const avatar = readTraitString(traits, "avatar");
  if (avatar !== null) attribute["image_url"] = avatar;

  const dob = brazeDob(normalized.identity.birthday ?? null);
  if (dob !== null) attribute["dob"] = dob;
  const gender = BRAZE_GENDER_TOKENS[normalized.identity.gender ?? ""];
  if (gender !== undefined) attribute["gender"] = gender;

  const country = brazeCountry(normalized, geoFallback);
  if (country !== null) attribute["country"] = country;
  const homeCity = brazeHomeCity(normalized, geoFallback);
  if (homeCity !== null) attribute["home_city"] = homeCity;
}

/**
 * Braze's `dob` is `YYYY-MM-DD`; the canonical birthday is `YYYYMMDD`.
 *
 * Reformatted from the canonical value rather than re-read off
 * `traits.birthday`, so the day Braze stores is the day Meta matched on.
 * `person.ts` has already refused a date that is not one — `"1990-02-30"`
 * has the shape and is not a day — which is what makes the slicing safe.
 * The pattern check is for the hand-built identity literals in tests, where
 * the type permits a value the normalizer would never produce.
 */
function brazeDob(birthday: string | null): string | null {
  if (birthday === null || !/^\d{8}$/.test(birthday)) return null;
  return `${birthday.slice(0, 4)}-${birthday.slice(4, 6)}-${birthday.slice(6, 8)}`;
}

/**
 * Braze's `country`: ISO-3166-1 alpha-2, upper case.
 *
 * The profile's own address first, the request's geo second, which is the
 * ordering the switch exists to make safe — a person who told the brand
 * where they live outranks the network they happened to be on. Upper-cased
 * whichever answered, so a segment on `country = "BR"` matches one
 * population rather than two.
 *
 * A geo value that is not two letters is dropped rather than sent. The
 * envelope's geo block caps the field at eight characters and the enricher
 * writes MaxMind's alpha-2 into it, but a country is the field where a
 * confident guess puts a person in another country's audience, so the
 * schema's slack is not treated as permission.
 */
function brazeCountry(normalized: NormalizedEvent, geoFallback: boolean): string | null {
  const fromTraits = normalized.identity.country ?? null;
  if (fromTraits !== null) return fromTraits.toUpperCase();
  if (!geoFallback) return null;
  const fromGeo = geoValue(normalized.enrichment.geo?.country);
  if (fromGeo === null || !/^[A-Za-z]{2}$/.test(fromGeo)) return null;
  return fromGeo.toUpperCase();
}

/**
 * Braze's `home_city` — a city NAME, which is why this one reads the trait
 * bag where `country` reads the identity block beside it. `identity.city`
 * is `"menlopark"`: correct as a hash input, and wrong as the string a
 * campaign renders and a marketer segments on.
 */
function brazeHomeCity(normalized: NormalizedEvent, geoFallback: boolean): string | null {
  const fromTraits = readTraitString(readTraitRecord(normalized.traits, "address"), "city");
  if (fromTraits !== null) return fromTraits;
  if (!geoFallback) return null;
  return geoValue(normalized.enrichment.geo?.city);
}

/**
 * Copy allowlisted traits onto the attribute object as custom attributes.
 *
 * `null` traits — no snapshot, or one over the size guard — leave the
 * attribute exactly as it was, which is what makes this safe to run on an
 * envelope that has not been enriched.
 *
 * Runs after `applyStandardAttributes`, and the reserved check is what
 * makes the order irrelevant: no allowlisted name is one Braze owns, so a
 * custom attribute cannot land on a standard slot whichever ran first.
 */
function applyTraitAttributes(
  attribute: Record<string, unknown>,
  traits: Readonly<Record<string, unknown>> | null,
): void {
  if (traits === null) return;
  for (const [path, name] of Object.entries(BRAZE_TRAIT_ATTRIBUTES)) {
    if (BRAZE_RESERVED_ATTRIBUTE_KEYS.includes(name)) continue;
    const value = readTraitPath(traits, path);
    if (value === undefined || value === null) continue;
    attribute[name] = value;
  }
}

/**
 * Read `total_orders` or `company.name` out of a trait snapshot.
 *
 * One level of nesting is all the catalog pins — `address` and `company` —
 * so this walks one dot and no further. A deeper path is a trait shape
 * nobody has agreed on, and refusing it here is cheaper than finding it in
 * a Braze account later.
 */
function readTraitPath(traits: Readonly<Record<string, unknown>>, path: string): unknown {
  const dot = path.indexOf(".");
  if (dot === -1) return traits[path];
  const bag = readTraitRecord(traits, path.slice(0, dot));
  return bag === null ? undefined : bag[path.slice(dot + 1)];
}

/** `readString` over a bag that may be absent entirely. */
function readTraitString(
  bag: Readonly<Record<string, unknown>> | null,
  key: string,
): string | null {
  return bag === null ? null : readString(bag, key);
}

/** A nested trait bag (`address`, `company`); `null` when it is not one. */
function readTraitRecord(
  bag: Readonly<Record<string, unknown>> | null,
  key: string,
): Readonly<Record<string, unknown>> | null {
  if (bag === null) return null;
  const value = bag[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Readonly<Record<string, unknown>>;
}

/** A geo slot, trimmed. `null` when absent or blank. */
function geoValue(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * `user.identified` → `attributes[]` entry.
 *
 * First-touch identification: Braze creates the user profile when one
 * doesn't already exist (`_update_existing_only=false`), then writes the
 * identifier slots (email, phone), the locale, the standard profile fields
 * the trait snapshot carries, and the curated custom attributes.
 *
 * The trait halves are two decisions rather than one, and
 * `applyStandardAttributes` is where the split is argued: names and URLs
 * keep the producer's spelling, codes come from the canonical identity
 * slots the shared normalizer built, and everything else rides the
 * allowlist under the name that table gives it.
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
    [trait: string]: unknown;
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
  applyStandardAttributes(attribute, ctx.normalized, locationFromGeo(ctx.instance));
  applyTraitAttributes(attribute, ctx.normalized.traits);

  attachDeviceIdIfApp(attribute, identifier, ctx.normalized);
  const frozen = Object.freeze(attribute) as BrazeAttributeObject;
  const payload: BrazePayload = { attributes: Object.freeze([frozen]) };
  return { kind: "mapped", payload, dedupe_key: ctx.normalized.event_id };
};

/**
 * `audience.entered` / `audience.exited` → `attributes[]` entry.
 *
 * One boolean custom attribute per audience, `true` on entry and `false`
 * on exit. Not a deletion on exit: Braze segments on
 * `polaris_audience_x = false` perfectly well, while an absent attribute
 * is indistinguishable from "this user predates the audience" — and a
 * campaign targeting non-members would silently include everyone the
 * platform has never evaluated.
 *
 * `_update_existing_only: true`, unlike `user.identified`. A transition
 * is not a first-touch identification: if Braze has never heard of this
 * customer, creating a bare profile carrying nothing but an audience
 * flag adds a user the brand cannot message and inflates their MAU
 * billing. The membership is already durable in Polaris and the next
 * `user.identified` creates the profile properly.
 *
 * Skips when no identifier resolves — the ordinary case for a profile
 * with no canonical customer id, which is a profile no vendor can act on.
 */
function buildAudienceAttributeMapper(member: boolean): Mapper<BrazePayload> {
  return (ctx: MapperContext): MapperResult<BrazePayload> => {
    const audience = ctx.normalized.properties["audience"];
    if (typeof audience !== "string" || audience.trim().length === 0) {
      // The property schema guarantees this upstream; a mapper that
      // trusted it and wrote `polaris_audience_undefined` would put a
      // permanent junk attribute on every user it touched.
      return { kind: "skip", reason: "audience_missing_from_properties" };
    }
    const identifier = resolveBrazeIdentifier(ctx.normalized);
    if (identifier === null) {
      return { kind: "skip", reason: "no_identifier_for_braze_attribute" };
    }

    const attribute: Record<string, unknown> = {
      // Never create a user from a membership change. See above.
      _update_existing_only: true,
      [brazeAudienceAttribute(audience.trim())]: member,
    };
    applyBrazeIdentifier(attribute, identifier);
    const frozen = Object.freeze(attribute) as BrazeAttributeObject;
    return {
      kind: "mapped",
      payload: { attributes: Object.freeze([frozen]) },
      dedupe_key: ctx.normalized.event_id,
    };
  };
}

export const audienceEnteredMapper: Mapper<BrazePayload> = buildAudienceAttributeMapper(true);
export const audienceExitedMapper: Mapper<BrazePayload> = buildAudienceAttributeMapper(false);

/**
 * `journey.step_advanced` → `events[]` entry named `polaris_journey_step`.
 *
 * This is the path §6.1 of the redesign describes: an action step emits an
 * event, the event travels the ordinary destination route, and a vendor
 * acts on it. The orchestrator holds no vendor credentials and makes no
 * vendor call, so "a journey sent this" and "a destination sent this" stay
 * ONE delivery record rather than two.
 *
 * The action's own payload rides `properties.properties`, carried through
 * the orchestrator uninterpreted — deciding what `message:
 * "thank_you_repeat"` means is this layer's job, not the engine's. It is
 * merged UNDER the journey coordinates, so a payload key called `journey`
 * or `step_id` cannot overwrite the ones a campaign filters on.
 *
 * Values are flattened to primitives. Braze rejects nested objects in
 * custom-event properties, and a mapper that passed one through would
 * produce a 400 the runtime records as a delivery failure — a vendor
 * error for a payload this layer could see was wrong.
 *
 * Skips without an identifier, like every Braze event mapper: Braze
 * rejects `events[]` entries with no external/braze id, and a skip is
 * cheaper than the round trip.
 */
export const journeyStepAdvancedMapper: Mapper<BrazePayload> = (
  ctx: MapperContext,
): MapperResult<BrazePayload> => {
  const journey = readString(ctx.normalized.properties, "journey");
  const stepId = readString(ctx.normalized.properties, "step_id");
  if (journey === null || stepId === null) {
    // Guaranteed upstream by the property schema. A mapper that trusted
    // that and sent `journey: undefined` would make every campaign filter
    // silently match nothing.
    return { kind: "skip", reason: "journey_coordinates_missing_from_properties" };
  }
  const identifier = resolveBrazeIdentifier(ctx.normalized);
  if (identifier === null) {
    return { kind: "skip", reason: "no_identifier_for_braze_event" };
  }

  const properties: Record<string, string | number | boolean> = {};
  const action = ctx.normalized.properties["properties"];
  if (action !== null && typeof action === "object" && !Array.isArray(action)) {
    for (const [key, value] of Object.entries(action as Record<string, unknown>)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        properties[key] = value;
      }
    }
  }
  // After the action payload, never before. See above.
  properties["journey"] = journey;
  properties["step_id"] = stepId;
  const version = ctx.normalized.properties["journey_version"];
  if (typeof version === "number") properties["journey_version"] = version;

  const eventBuilder = applyBrazeIdentifier(
    {
      name: BRAZE_EVENT_JOURNEY_STEP,
      time: ctx.normalized.occurred_at,
      properties: Object.freeze(properties) as BrazeJourneyEventProperties,
    },
    identifier,
  );
  attachDeviceIdIfApp(eventBuilder, identifier, ctx.normalized);
  const event = eventBuilder as BrazeEventObject;
  return {
    kind: "mapped",
    payload: { events: Object.freeze([Object.freeze(event)]) },
    dedupe_key: ctx.normalized.event_id,
  };
};

/**
 * `journey.entered` / `journey.exited` → `attributes[]` entry.
 *
 * One boolean per journey, `true` on entry and `false` on exit — the same
 * shape as audience membership, for the same reason: an ABSENT attribute
 * is indistinguishable from "this user predates the journey", so a
 * suppression rule written against non-members would quietly include
 * everyone Polaris has never evaluated.
 *
 * `_update_existing_only: true`. Entering a journey is not a first-touch
 * identification, and creating a bare Braze profile carrying nothing but a
 * journey flag adds a user the brand cannot message and inflates their MAU
 * billing.
 */
function buildJourneyAttributeMapper(member: boolean): Mapper<BrazePayload> {
  return (ctx: MapperContext): MapperResult<BrazePayload> => {
    const journey = readString(ctx.normalized.properties, "journey");
    if (journey === null) {
      return { kind: "skip", reason: "journey_missing_from_properties" };
    }
    const identifier = resolveBrazeIdentifier(ctx.normalized);
    if (identifier === null) {
      return { kind: "skip", reason: "no_identifier_for_braze_attribute" };
    }

    const attribute: Record<string, unknown> = {
      _update_existing_only: true,
      [brazeJourneyAttribute(journey)]: member,
    };
    applyBrazeIdentifier(attribute, identifier);
    const frozen = Object.freeze(attribute) as BrazeAttributeObject;
    return {
      kind: "mapped",
      payload: { attributes: Object.freeze([frozen]) },
      dedupe_key: ctx.normalized.event_id,
    };
  };
}

export const journeyEnteredMapper: Mapper<BrazePayload> = buildJourneyAttributeMapper(true);
export const journeyExitedMapper: Mapper<BrazePayload> = buildJourneyAttributeMapper(false);

// ---------------------------------------------------------------------------
// External ID resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the Braze `external_id` from the normalized identity. Order:
 *
 *   1. `identity.canonical_customer_id` — the spine's resolved customer
 *   2. `identity.user_id`  — the envelope's own `customer_id`
 *   3. `identity.anonymous_id`  — surfaces unauthenticated events under
 *      a stable anonymous identifier (Braze accepts non-prefixed strings)
 *
 * Returns `null` when no slot is populated. The normalize layer drops
 * events that have no usable identity at all (`no_usable_identity`), so
 * this branch only fires for events whose only usable identity was
 * email/phone or a bare `profile_id` — Braze keys on neither in v1.
 *
 * ## `canonical_customer_id` comes first
 *
 * It is the platform's own best identity — `pickBestIdentity` ranks it
 * first — and it is the slot the spine populates on `resolved.events`
 * from the profile block. Reading only `user_id` meant an event whose
 * identity block was empty but whose PROFILE block carried a resolved
 * customer id fell through to `user_alias`, then `device_id`, then a
 * skip. That is the ordinary shape of a spine event for a known
 * customer, and of every profile-plane event, so Braze was skipping
 * deliveries it had a perfectly good identifier for.
 *
 * `profile_id` is deliberately NOT a fallback. It is Polaris's internal
 * surrogate: keying a Braze user on it would create a profile under an
 * id the brand's own systems have never seen, and Braze has no way to
 * reconcile it later.
 *
 * Lowercased + trimmed for Braze's case-insensitive identifier
 * comparison (matches Braze's documented behavior).
 */
export function resolveExternalId(normalized: NormalizedEvent): string | null {
  const canonical = normalized.identity.canonical_customer_id;
  if (canonical !== null) {
    const trimmed = canonical.trim().toLowerCase();
    if (trimmed.length > 0) return trimmed;
  }
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
