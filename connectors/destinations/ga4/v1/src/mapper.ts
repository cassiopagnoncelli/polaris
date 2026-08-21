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
 *   - `checkout.started`     → `begin_checkout`
 *   - `payment.approved`     → `purchase`
 *   - `user.identified`      → `login` (method='polaris')
 *   - `signup.completed`     → `sign_up` (method='polaris')
 *   - `subscription.renewed` → `subscription_renewed` (custom event)
 *   - `page.viewed`          → `page_view`
 *
 * Independently of which event it is, every payload this module builds
 * carries `engagement_time_msec`, the page parameters, a session id when
 * the envelope has a session, and a `wrapper` block with the consent
 * settings, user properties, user id and location. Those are not per-event
 * decisions — they are what makes an event count in GA4 at all — so they
 * live in `buildResult` rather than in six copies.
 *
 * GA4 has no recommended event for subscription renewals, so v1 emits
 * a snake_case custom event (`subscription_renewed`) carrying the
 * canonical `currency`, `value` (minor → major), and the
 * subscription's per-cycle id stamped on `params.transaction_id` for
 * operator triage parity with `purchase`. Only `purchase` retains the
 * cross-channel dedupe promise — GA4 does not dedupe custom events.
 *
 * Events outside this set produce `mapped_failed` records at the
 * runtime layer (no mapper registered).
 */

import type { ConsentEvaluation, FlatContext, NormalizedEvent } from "@polaris/delivery-normalize";
import { hasAppContext, minorToMajor, sha256Hex } from "@polaris/delivery-normalize";
import type {
  DestinationInstance,
  Mapper,
  MapperContext,
  MapperResult,
} from "@polaris/delivery-destinations";

import type {
  Ga4ConsentSettings,
  Ga4ConsentState,
  Ga4EventItem,
  Ga4EventParams,
  Ga4EventPayload,
  Ga4UserLocation,
  Ga4UserProperties,
  Ga4UserProperty,
  Ga4WrapperFields,
} from "./types.js";

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
export const GA4_EVENT_SIGN_UP = "sign_up" as const;
/**
 * GA4 custom event for subscription renewals. GA4 has no recommended
 * event for recurring billing; the snake_case name follows GA4's
 * documented custom-event naming convention. Operators see this
 * verbatim in the GA4 Events report.
 */
export const GA4_EVENT_SUBSCRIPTION_RENEWED = "subscription_renewed" as const;
/**
 * GA4's recommended page-view event. Automatically collected by gtag on a
 * browser; the Measurement Protocol has to be told, and until now was not
 * — `page.viewed` had no mapper at all and landed as `skipped_unmapped`.
 */
export const GA4_EVENT_PAGE_VIEW = "page_view" as const;

/**
 * GA4 `method` value the v1 mapper stamps on `login` and `sign_up`.
 * Keeps the canonical identity-emission source labeled so GA4 reports
 * can split out Polaris-driven logins / signups from organic gtag
 * events that share the same vendor event name.
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
  "signup.completed": GA4_EVENT_SIGN_UP,
  "subscription.renewed": GA4_EVENT_SUBSCRIPTION_RENEWED,
  "page.viewed": GA4_EVENT_PAGE_VIEW,
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
  return buildResult(GA4_EVENT_BEGIN_CHECKOUT, params, ctx.normalized.event_id, ctx);
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
  return buildResult(GA4_EVENT_PURCHASE, params, dedupeKey, ctx);
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
  return buildResult(GA4_EVENT_LOGIN, params, ctx.normalized.event_id, ctx);
};

/**
 * `signup.completed` → `sign_up` (method=`polaris`).
 *
 * GA4's recommended `sign_up` event carries a `method` parameter that
 * labels the auth provider, mirroring the `login` event shape. v1
 * stamps `polaris` so GA4 reports can split Polaris-driven signups
 * out from organic gtag-fired ones. GA4 has no documented cross-event
 * dedupe for `sign_up`, so the Polaris-side dedupe_key falls through
 * to the canonical `event_id`.
 */
export const signupCompletedMapper: Mapper<Ga4EventPayload> = (
  ctx: MapperContext,
): MapperResult<Ga4EventPayload> => {
  const params: ParamsBuilder = { method: GA4_LOGIN_METHOD_POLARIS };
  return buildResult(GA4_EVENT_SIGN_UP, params, ctx.normalized.event_id, ctx);
};

/**
 * `subscription.renewed` → `subscription_renewed` (custom event).
 *
 * GA4 has no recommended event for recurring billing; v1 emits a
 * snake_case custom event. Pulls `amount_minor` (or legacy `amount`) +
 * `currency` off `properties` and converts to GA4's decimal `value`.
 * The per-cycle `subscription_id` lands on `params.transaction_id` for
 * triage parity with `purchase`, but GA4 does NOT dedupe custom events
 * — the Polaris-side dedupe_key still keys on the canonical
 * `event_id` so retries against the same renewal envelope stay stable.
 */
export const subscriptionRenewedMapper: Mapper<Ga4EventPayload> = (
  ctx: MapperContext,
): MapperResult<Ga4EventPayload> => {
  const props = ctx.normalized.properties;
  const currency = readString(props, "currency");
  const amountMinor = readInteger(props, "amount_minor") ?? readInteger(props, "amount");
  const subscriptionId = readString(props, "subscription_id");

  const params: ParamsBuilder = {};
  if (currency !== null && amountMinor !== null) {
    params.currency = currency;
    const value = safeMinorToMajor(amountMinor, currency);
    if (value !== undefined) params.value = value;
  } else if (currency !== null) {
    params.currency = currency;
  }
  if (subscriptionId !== null) params.transaction_id = subscriptionId;

  return buildResult(GA4_EVENT_SUBSCRIPTION_RENEWED, params, ctx.normalized.event_id, ctx);
};

/**
 * `page.viewed` → `page_view`.
 *
 * No event-specific params of its own: `page_location` / `page_referrer`
 * / `page_title` ride every event this module builds (see
 * `applyPageParams`), and on this one they are the entire payload. GA4
 * has no dedupe for `page_view`, so the Polaris-side key stays on the
 * canonical `event_id`.
 */
export const pageViewedMapper: Mapper<Ga4EventPayload> = (
  ctx: MapperContext,
): MapperResult<Ga4EventPayload> => {
  return buildResult(GA4_EVENT_PAGE_VIEW, {}, ctx.normalized.event_id, ctx);
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Finish a per-event mapper's work.
 *
 * The per-event mappers supply only what is specific to their event; this
 * adds everything that rides EVERY GA4 event and then assembles the
 * payload. The split matters because the fields added here are the ones
 * that decide whether GA4 counts the event at all, and six mappers each
 * remembering to set them is six chances to ship a sessionless event.
 *
 * `params` is never empty as a result, so the payload always carries one.
 */
function buildResult(
  eventName: string,
  params: ParamsBuilder,
  dedupeKey: string,
  ctx: MapperContext,
): MapperResult<Ga4EventPayload> {
  const { normalized } = ctx;
  applyPageParams(params, normalized.context);
  params.engagement_time_msec = resolveEngagementTimeMsec(ctx.instance);
  const sessionId = resolveSessionId(normalized);
  if (sessionId !== null) params.session_id = sessionId;

  const payload: Ga4EventPayload = {
    name: eventName,
    params: freezeParams(params),
    wrapper: buildWrapperFields(ctx),
  };
  return { kind: "mapped", payload, dedupe_key: dedupeKey };
}

/** Assemble the request-level half. See `Ga4WrapperFields`. */
function buildWrapperFields(ctx: MapperContext): Ga4WrapperFields {
  const { normalized } = ctx;
  const appInstanceId = resolveAppInstanceId(normalized);
  const userId = resolveUserId(normalized);
  const userProperties = resolveUserProperties(normalized);
  const userLocation = resolveUserLocation(normalized);
  const ip = normalized.context.ip;
  const userAgent = normalized.context.user_agent;

  return Object.freeze({
    client_id: resolveClientId(normalized),
    ...(appInstanceId !== null ? { app_instance_id: appInstanceId } : {}),
    ...(userId !== null ? { user_id: userId } : {}),
    occurred_at_epoch_ms: normalized.occurred_at_epoch_ms,
    consent: resolveConsent(normalized.consent),
    ...(userProperties !== null ? { user_properties: userProperties } : {}),
    // Loose null checks: `FlatContext` is fully populated by
    // `flattenContext`, but the hand-built literals in connector tests
    // predate some of its slots and omit them outright.
    ...(ip != null ? { ip_override: ip } : {}),
    ...(userAgent != null ? { user_agent: userAgent } : {}),
    ...(userLocation !== null ? { user_location: userLocation } : {}),
  });
}

/**
 * The GA4 `session_id` param, derived from the envelope's session hint.
 *
 * GA4's own session ids are numeric — gtag mints the session's start time
 * in Unix seconds — and while the Measurement Protocol accepts a string,
 * a property whose server-side events carry `sess_9f2c…` and whose
 * browser events carry `1755800000` reports two shapes of the same thing.
 * So the hint is HASHED to a number rather than sent as it arrived.
 *
 * The derivation is the first 48 bits of `SHA-256(session_id)`, read as an
 * unsigned integer. Three properties are load-bearing:
 *
 *   - **deterministic** — the same session produces the same id on every
 *     event in it and on every retry of each, which is the whole point:
 *     GA4 stitches a session by equality of this number.
 *   - **48 bits** — below `Number.MAX_SAFE_INTEGER`, so the value
 *     survives JSON round-tripping exactly. A 64-bit hash would not.
 *   - **shape-blind** — the hint is a producer-controlled string with no
 *     pinned format (`sess_<hex>` from the sessionizer, a UUID from one
 *     SDK, whatever a backend sends), so reading digits out of it would
 *     work for one producer and collapse to a constant for the next.
 *
 * Collisions are birthday-bounded at 2^24 concurrent sessions, which is
 * not a scale a single GA4 property reaches.
 *
 * Returns `null` when the envelope has no session — a backend event
 * usually does not, and GA4 treats a sessionless event as such rather
 * than inventing one.
 */
export function resolveSessionId(normalized: NormalizedEvent): number | null {
  const sessionId = normalized.identity.session_id;
  if (sessionId === undefined || sessionId === null) return null;
  return Number.parseInt(sha256Hex(sessionId).slice(0, 12), 16);
}

/**
 * GA4's `user_id`: the platform's resolution first, the producer's claim
 * second. Same rule as Meta's `external_id` — `canonical_customer_id` is
 * what the identity stage concluded after reconciling every identifier
 * ever seen for the person, where `user_id` is what this one event's
 * producer happened to send, so two producers spelling the same customer
 * differently converge on one GA4 user instead of two.
 *
 * Unhashed, unlike Meta's: GA4 consumes `user_id` as an opaque string and
 * matches it against the id the site's own gtag sets.
 */
export function resolveUserId(normalized: NormalizedEvent): string | null {
  return normalized.identity.canonical_customer_id ?? normalized.identity.user_id;
}

/**
 * The GA4 web-stream `client_id`.
 *
 * GA4 treats `client_id` as the browser instance — the thing a session
 * belongs to. Until now the deliverer synthesized it from `delivery_key`,
 * which is derived per (destination, event_id, identity) and is therefore
 * DIFFERENT FOR EVERY EVENT. GA4 has consequently been seeing one
 * single-event user per delivery: no sessions, no returning users, no
 * funnels that span two events. That is not a tuning issue, it is the
 * metric being wrong, and it is why the synthesis is deleted here rather
 * than left behind a flag.
 *
 * Order:
 *
 *   1. `anonymous_id`  — the SDK's per-browser id, which is what GA4 means.
 *   2. `profile_id`    — the platform's person, available on every resolved
 *                        envelope. Coarser than a browser: a person on two
 *                        devices becomes one GA4 client rather than two.
 *                        Correct for a backend event that has no browser to
 *                        name, and stable, which is the property that
 *                        matters most.
 *   3. `best_identity` — normalize drops an envelope with no usable
 *                        identity at all, so this always resolves and the
 *                        function never has to invent a value.
 */
export function resolveClientId(normalized: NormalizedEvent): string {
  return (
    normalized.identity.anonymous_id ??
    normalized.identity.profile_id ??
    normalized.best_identity.value
  );
}

/**
 * Synthesize an `app_instance_id` from the canonical envelope's
 * `context.app_*` slots when the event is sourced from a mobile app
 * (KCS3ATPC). GA4 Firebase / app streams require `app_instance_id` at
 * the request wrapper level; we use the platform-stable device-vendor
 * id (`app_idfv` for iOS — UUID; `app_gaid` for Android) so the value
 * is consistent across retries for the same device. Returns `null` for
 * envelopes that carry no app context, leaving the deliverer on the
 * web-stream path with the synthesized `client_id`.
 */
export function resolveAppInstanceId(normalized: NormalizedEvent): string | null {
  if (!hasAppContext(normalized.context)) return null;
  return normalized.context.app_idfv ?? normalized.context.app_gaid ?? null;
}

/**
 * Page parameters, on every event.
 *
 * GA4 attributes an event to a page by reading `page_location` off the
 * event itself. An event without it is attributed to `(not set)` even
 * when a `page_view` for the same session carried the URL one event
 * earlier — GA4 does not carry page context forward across Measurement
 * Protocol events the way gtag does in a browser. So these ride
 * everything, which is also what Segment's GA4 cloud destination does.
 *
 * Absent on a backend event with no page context, and that is correct:
 * `page_location` is a claim about where the user was.
 */
function applyPageParams(params: ParamsBuilder, context: FlatContext): void {
  // Loose null checks throughout: see the note in `buildWrapperFields`.
  if (context.page_url != null) params.page_location = context.page_url;
  if (context.page_referrer != null) params.page_referrer = context.page_referrer;
  if (context.page_title != null) params.page_title = context.page_title;
}

/** Default engagement claim, in milliseconds. See `Ga4EventParams`. */
export const GA4_DEFAULT_ENGAGEMENT_TIME_MSEC = 1;

/**
 * Per-instance override key for the engagement default.
 *
 * On `destinations.config` rather than in the project-config slice, and
 * the reason is a boundary rather than a preference: `engagement_time_msec`
 * is an event PARAM, so it is the mapper that sets it, and the mapper's
 * context carries the destination instance and no project configuration
 * at all. `MapperContext` is deliberately narrow — widening it to carry a
 * config slice is a shared-runtime decision, not this connector's.
 *
 * Two GA4 properties in one project are two instances and may want
 * different values, which is the case `destinations.config` exists for.
 */
export const GA4_ENGAGEMENT_TIME_CONFIG_KEY = "engagement_time_msec";

/**
 * Resolve the engagement claim for one delivery.
 *
 * Anything that is not a non-negative integer falls back to the default
 * rather than failing the mapping: the value is operator-supplied, and
 * dropping a producer's events over a typo in a tuning knob is the wrong
 * trade — the same stance `parseGa4ProjectConfig` takes on its slice.
 */
export function resolveEngagementTimeMsec(instance: DestinationInstance): number {
  const configured = instance.config[GA4_ENGAGEMENT_TIME_CONFIG_KEY];
  if (typeof configured === "number" && Number.isInteger(configured) && configured >= 0) {
    return configured;
  }
  return GA4_DEFAULT_ENGAGEMENT_TIME_MSEC;
}

/**
 * GA4 Consent Mode v2 settings from the envelope's consent block.
 *
 * `ad_user_data` reads `consent.marketing` and `ad_personalization` reads
 * `consent.personalization` — neither is a dimension this destination
 * GATES on, which is exactly why they are read from `consent.observed`
 * and not from the gate's own result. GA4 declares `analytics` and drops
 * on it; the other two are forwarded so Google can honour them.
 *
 * An absent dimension is GRANTED, per ADR-0001 #54 (normalize's
 * absent-as-true rule): a producer that has not wired consent signalling
 * is not making a negative statement, and `observed` has already applied
 * that rule. The `?? true` covers a `ConsentEvaluation` literal built by
 * hand before the field existed, and resolves the same way.
 */
export function resolveConsent(consent: ConsentEvaluation): Ga4ConsentSettings {
  const observed = consent.observed;
  return Object.freeze({
    ad_user_data: toConsentState(observed?.marketing ?? true),
    ad_personalization: toConsentState(observed?.personalization ?? true),
  });
}

function toConsentState(granted: boolean): Ga4ConsentState {
  return granted ? "GRANTED" : "DENIED";
}

/**
 * Profile traits GA4 accepts as user properties.
 *
 * An ALLOWLIST, not a passthrough, and for the reason Braze's
 * `BRAZE_TRAIT_ATTRIBUTES` is one: a GA4 property's user-property space
 * is a namespace an operator curates, capped at 25 registered
 * dimensions, and forwarding every trait would let a new field in the
 * profile store silently consume one. Adding a trait here is that
 * decision.
 *
 * `country` is read from the pinned `traits.address.country` slot rather
 * than from the top level — `user.identified` v1 pins the address keys
 * inside `address`, so that is where the canonical value is.
 */
export const GA4_TRAIT_USER_PROPERTIES: readonly string[] = Object.freeze([
  "plan",
  "tier",
  "lifecycle_stage",
]);

/** The trait key holding the pinned postal address. */
const ADDRESS_TRAIT_KEY = "address";

/** Address sub-keys forwarded as user properties, under their own names. */
const GA4_ADDRESS_USER_PROPERTIES: readonly string[] = Object.freeze(["country"]);

/**
 * User-property names GA4 reserves. A request naming one is rejected
 * whole (`NAME_RESERVED`), taking the event with it, so the screen runs
 * independently of the allowlist above: a mistake in curating that list
 * must not become a delivery outage. GA4 also reserves the `google_`,
 * `ga_` and `firebase_` prefixes.
 */
const GA4_RESERVED_USER_PROPERTY_NAMES: readonly string[] = Object.freeze([
  "first_open_time",
  "first_visit_time",
  "last_deep_link_referrer",
  "user_id",
  "first_open_after_install",
]);
const GA4_RESERVED_USER_PROPERTY_PREFIXES: readonly string[] = Object.freeze([
  "google_",
  "ga_",
  "firebase_",
]);

/**
 * Build `user_properties` from the profile-trait snapshot.
 *
 * `null` traits — no snapshot, or one over the size guard — produce no
 * block at all, which is what makes this safe on an envelope that has
 * never been through the spine. Values are forwarded as the profile
 * holds them (GA4 takes strings, numbers and booleans); anything
 * structured is skipped rather than stringified, because a trait that
 * lands in a GA4 report as `[object Object]` is worse than an absent one.
 */
export function resolveUserProperties(normalized: NormalizedEvent): Ga4UserProperties | null {
  const traits = normalized.traits;
  if (traits === null) return null;

  const out: Record<string, Ga4UserProperty> = {};
  for (const key of GA4_TRAIT_USER_PROPERTIES) {
    applyUserProperty(out, key, traits[key]);
  }
  const address = readRecord(traits, ADDRESS_TRAIT_KEY);
  if (address !== null) {
    for (const key of GA4_ADDRESS_USER_PROPERTIES) {
      applyUserProperty(out, key, address[key]);
    }
  }
  return Object.keys(out).length > 0 ? Object.freeze(out) : null;
}

function applyUserProperty(
  out: Record<string, Ga4UserProperty>,
  name: string,
  value: unknown,
): void {
  if (isReservedUserPropertyName(name)) return;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return;
  if (typeof value === "string" && value.trim().length === 0) return;
  out[name] = Object.freeze({ value });
}

function isReservedUserPropertyName(name: string): boolean {
  if (GA4_RESERVED_USER_PROPERTY_NAMES.includes(name)) return true;
  return GA4_RESERVED_USER_PROPERTY_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * ISO-3166-2 subdivision codes are one to three alphanumerics (`CA`,
 * `ENG`, `13`). The geo enricher falls back to the subdivision NAME for
 * countries whose subdivisions carry no code, and GA4 rejects a name
 * outright (`region_id [California] is invalid`) — taking the request
 * with it. So the shape is screened before the code is used.
 */
const ISO_SUBDIVISION_CODE = /^[A-Za-z0-9]{1,3}$/;

/**
 * GA4's structured geo from what the enrichment stage resolved.
 *
 * Reads `enrichment.geo` rather than re-deriving from an IP, which is
 * the point of the enrichment block: the address may already have been
 * redacted by the time a mapper runs.
 *
 * `region_id` wants the full ISO-3166-2 form (`US-CA`) while
 * `enrichment.geo.region` holds the bare subdivision code (`CA`), so the
 * two are composed — and only when a country is known to compose with.
 */
export function resolveUserLocation(normalized: NormalizedEvent): Ga4UserLocation | null {
  const geo = normalized.enrichment.geo;
  if (geo === null || geo === undefined) return null;

  const out: { city?: string; region_id?: string; country_id?: string } = {};
  const country = geo.country;
  if (country != null) out.country_id = country;
  if (country != null && geo.region != null && ISO_SUBDIVISION_CODE.test(geo.region)) {
    out.region_id = `${country}-${geo.region}`;
  }
  if (geo.city != null) out.city = geo.city;
  return Object.keys(out).length > 0 ? Object.freeze(out) : null;
}

function readRecord(
  bag: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> | null {
  const value = bag[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Readonly<Record<string, unknown>>;
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
