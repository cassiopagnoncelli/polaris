/**
 * Local types for the ga4 v1 consumer.
 *
 * The mapper produces a `Ga4EventPayload`: one entry for the GA4
 * Measurement Protocol request body's `events[]` array, plus the
 * request-level fields the wrapper needs on a `wrapper` side channel. The
 * deliverer lifts that side channel out, wraps what remains, and POSTs to
 * `https://www.google-analytics.com/mp/collect?measurement_id=<id>&api_secret=<secret>`.
 * The runtime never inspects the payload contents.
 *
 * Reference: https://developers.google.com/analytics/devguides/collection/protocol/ga4
 */

/**
 * GA4 Measurement Protocol per-event payload shape.
 *
 * Each entry inside `events[]` carries a `name` (e.g. `purchase`,
 * `begin_checkout`, `login`) and a `params` object with event-specific
 * slots. GA4 reserves a small set of recommended params per recommended
 * event (e.g. `currency`, `value`, `transaction_id` for `purchase`);
 * any non-reserved key lands as a custom dimension on the property.
 *
 * `name` and `params` are the wire shape. `wrapper` is not: it is the
 * mapper's side channel to the deliverer, stripped before serializing.
 */
export interface Ga4EventPayload {
  /** Vendor event name (`purchase`, `begin_checkout`, `login`, ...). */
  readonly name: string;
  /** Event-specific params (currency, value, transaction_id, ...). */
  readonly params?: Ga4EventParams;
  /**
   * Request-level fields, resolved by the mapper and lifted onto
   * `Ga4RequestBody` by the deliverer. Never serialized inside the
   * `events[]` entry.
   *
   * ONE nested object rather than a key per field, and that is the whole
   * point of it. These used to be two loose top-level keys the deliverer
   * destructured off the payload, passing the REST through to the wire —
   * so a field added here and forgotten there did not fail to arrive, it
   * arrived in the wrong place, inside the event. GA4 rejects an
   * `events[]` entry carrying an unknown key, which would have taken the
   * whole request with it. With one key there is one thing to lift, and
   * the type makes forgetting it a compile error rather than a 400.
   *
   * The mapper is the only stage that can populate this: the deliverer
   * sees the mapped payload and never the canonical envelope.
   */
  readonly wrapper: Ga4WrapperFields;
}

/**
 * The request-level half of a mapped GA4 event.
 *
 * Everything here lands on `Ga4RequestBody` rather than inside
 * `events[]`, and everything here is resolved from the canonical envelope
 * — which is why it is the mapper that fills it in.
 */
export interface Ga4WrapperFields {
  /**
   * GA4's web-stream client id — the browser instance a session belongs
   * to. REQUIRED, deliberately: as an optional slot the deliverer needed
   * a fallback, the only sane fallback was the `delivery_key` synthesis
   * that made every event its own single-event user, and that fallback
   * silently reinstated the old behaviour for any payload built by hand.
   * A required field makes the mapper the single place it can come from.
   */
  readonly client_id: string;
  /**
   * Firebase / app-stream identifier (KCS3ATPC). Synthesized from
   * `context.app_idfv` / `context.app_gaid` when the envelope reports an
   * app source. The deliverer routes to the app-stream URL and stamps
   * this INSTEAD of `client_id` — but only when the operator's secret
   * also carries `firebase_app_id`.
   */
  readonly app_instance_id?: string;
  /**
   * GA4's cross-platform user id. `canonical_customer_id` first, then the
   * producer's `customer_id`; absent when neither is known.
   */
  readonly user_id?: string;
  /**
   * `occurred_at` in epoch milliseconds, for the deliverer to convert to
   * `timestamp_micros`.
   *
   * The mapper hands over the milliseconds rather than the micros because
   * the value is not unconditional in the way the rest of this block is:
   * GA4 accepts a backdated timestamp only within 72 hours of receipt, so
   * whether to send it at all is a question about NOW. The mapper is pure
   * and has no clock; the deliverer has one.
   */
  readonly occurred_at_epoch_ms: number;
  /**
   * GA4 Consent Mode settings. Always present — a receiver that is told
   * nothing assumes the property's default, so "no consent block" is
   * itself a claim, and not the one the envelope makes.
   */
  readonly consent: Ga4ConsentSettings;
  /** Operator-curated profile traits. Absent when none survived the allowlist. */
  readonly user_properties?: Ga4UserProperties;
  /** `context.ip`, for GA4's own geo derivation. */
  readonly ip_override?: string;
  /** `context.user_agent`, for GA4's own device derivation. */
  readonly user_agent?: string;
  /** Geo as the enrichment stage resolved it, in GA4's structured form. */
  readonly user_location?: Ga4UserLocation;
}

/**
 * GA4 Consent Mode v2 settings, request level.
 *
 * Two keys, both required by this connector even though the Measurement
 * Protocol treats each as optional: see `Ga4WrapperFields.consent`. GA4
 * accepts only the two literals per key.
 */
export interface Ga4ConsentSettings {
  readonly ad_user_data: Ga4ConsentState;
  readonly ad_personalization: Ga4ConsentState;
}

/** GA4's consent enum. Any other value is rejected by the endpoint. */
export type Ga4ConsentState = "GRANTED" | "DENIED";

/**
 * GA4 `user_properties`, request level: `{ <name>: { value } }`.
 *
 * GA4 caps a request at 25 user properties, names at 24 characters and
 * values at 36; the allowlist in `mapper.ts` is four keys, so the caps
 * are documented here rather than enforced. Values over the limit are
 * truncated by GA4 rather than rejected.
 */
export type Ga4UserProperties = Readonly<Record<string, Ga4UserProperty>>;

/** One `user_properties` entry. */
export interface Ga4UserProperty {
  readonly value: string | number | boolean;
}

/**
 * GA4's structured geo, request level.
 *
 * `region_id` is ISO-3166-2 (`US-CA`) and the endpoint validates it: a
 * subdivision NAME is rejected outright, which matters because the geo
 * enricher falls back to the name for countries whose subdivisions carry
 * no ISO code. `mapper.ts` screens for the code shape before composing.
 *
 * `subcontinent_id` / `continent_id` (UN M49) are documented by GA4 and
 * omitted here: `enrichment.geo` does not resolve them.
 */
export interface Ga4UserLocation {
  readonly city?: string;
  readonly region_id?: string;
  readonly country_id?: string;
}

/**
 * GA4 `params` shape. Event-specific; the per-event mapper populates
 * only the fields the canonical envelope carries. GA4 accepts arbitrary
 * keys but reserves a documented set of recommended param names per
 * recommended event.
 *
 * `items[]` is GA4's product-detail array (item_id, item_name,
 * quantity, price); v1 emits it when canonical `properties.items[]` is
 * present on `purchase` / `begin_checkout`.
 */
export interface Ga4EventParams {
  readonly currency?: string;
  readonly value?: number;
  /** GA4's documented purchase dedupe slot. Polaris-stable. */
  readonly transaction_id?: string;
  /** Per-product detail array. */
  readonly items?: readonly Ga4EventItem[];
  /** `login` / `sign_up` carry `method` to label the auth provider. */
  readonly method?: string;
  /**
   * Milliseconds of engagement since the preceding event.
   *
   * On EVERY event, and never absent. GA4 counts an event towards
   * engagement — and therefore towards the standard and realtime reports
   * at all — only when this param is present; without it the Measurement
   * Protocol delivers events that arrive, store, and appear nowhere an
   * operator looks. The default of `1` is the smallest honest claim
   * ("engaged, duration unknown"), which is the same thing Segment's GA4
   * cloud destination sends. Measured engagement is QMZPA's.
   */
  readonly engagement_time_msec?: number;
  /**
   * The GA4 session this event belongs to.
   *
   * A NUMBER, derived from the envelope's session hint — see
   * `resolveSessionId`. GA4 accepts a string too, but every id it mints
   * itself is numeric and the reports read better for matching it.
   * Absent when the envelope carries no session, which is the normal
   * state of a backend event.
   */
  readonly session_id?: number;
  /**
   * Page parameters, on every event rather than only on `page_view`.
   *
   * GA4 attributes an event to a page by reading these off the event
   * itself; an event without them is attributed to `(not set)` even when
   * a `page_view` for the same session carried the URL. Segment's GA4
   * cloud destination sends them on everything for the same reason.
   */
  readonly page_location?: string;
  readonly page_referrer?: string;
  readonly page_title?: string;
}

/**
 * One entry inside `params.items[]`. GA4 recommends shipping one entry
 * per cart line with `item_id` + `quantity` + `price`. The v1 mapper
 * omits brand/category/variant until a canonical slot carries them.
 */
export interface Ga4EventItem {
  readonly item_id?: string;
  readonly item_name?: string;
  readonly item_category?: string;
  readonly item_brand?: string;
  readonly item_variant?: string;
  readonly price?: number;
  readonly quantity?: number;
}

/**
 * GA4 Measurement Protocol request body shape. The deliverer constructs
 * this wrapper around one payload per request; GA4 accepts up to 25
 * events per request but v1 ships one event per HTTP call so the
 * delivery record granularity matches the canonical-event granularity.
 *
 * This type is authoritative for the wire: the endpoint rejects the whole
 * request over one key it does not recognise (`no such field`), so every
 * field here was checked against `/debug/mp/collect` rather than against
 * the reference alone. `device` is documented by GA4 and deliberately
 * absent — the S1 context slots it needs are NNH85's.
 */
export interface Ga4RequestBody {
  /**
   * GA4 stream identifier at the wrapper level. EXACTLY ONE of
   * `client_id` (web-stream, Measurement Protocol) or `app_instance_id`
   * (Firebase / app-stream) is set per request — GA4's two URL flavors
   * key on different wrapper identifiers. The deliverer chooses based
   * on the resolved secret (`measurement_id` vs `firebase_app_id`) and
   * the mapper-supplied `Ga4WrapperFields.app_instance_id` hint.
   */
  readonly client_id?: string;
  readonly app_instance_id?: string;
  readonly user_id?: string;
  /**
   * Microseconds since the Unix epoch. Sent on every request whose
   * `occurred_at` is inside GA4's 72-hour backdating window and omitted
   * outside it — the endpoint does NOT reject an older value, it accepts
   * the request and silently discards the event, so the window is the
   * deliverer's to enforce.
   */
  readonly timestamp_micros?: number;
  /** Consent Mode v2 signals. Always sent. */
  readonly consent?: Ga4ConsentSettings;
  /** Operator-curated profile traits, as GA4 user properties. */
  readonly user_properties?: Ga4UserProperties;
  /** IP address GA4 derives geographic information from. */
  readonly ip_override?: string;
  /** User agent GA4 derives device information from. */
  readonly user_agent?: string;
  /** Structured geographic information, when enrichment resolved any. */
  readonly user_location?: Ga4UserLocation;
  readonly events: readonly Ga4WireEvent[];
}

/**
 * One `events[]` entry as it goes on the wire: `Ga4EventPayload` with the
 * mapper's `wrapper` side channel removed.
 *
 * Named rather than inlined so the deliverer's strip is checkable — a
 * `Ga4EventPayload` does not satisfy this type, which is what stops the
 * side channel reaching GA4.
 */
export interface Ga4WireEvent {
  readonly name: string;
  readonly params?: Ga4EventParams;
}

/**
 * The GA4 credential, read from `destinations.secret_value` and handed to
 * the deliverer as `DelivererContext.secret`. Stored plaintext in the control
 * plane; this consumer only ever parses and uses it.
 *
 * Shape: a JSON document
 *
 *   { "measurement_id": "G-XXXXXXXXXX", "api_secret": "..." }
 *
 * `measurement_id` is the GA4 data stream's public identifier (also
 * visible in the web SDK config); `api_secret` is the property-scoped
 * Measurement Protocol secret operators rotate via the GA4 Admin UI.
 * Both fields are required by the deliverer; missing fields land as
 * `failed_permanent` (`error_class: 'auth'`).
 */
export interface ResolvedGa4Secret {
  readonly measurement_id: string;
  readonly api_secret: string;
  /**
   * Firebase app id (`1:NNN:PLATFORM:HASH`) for routing mobile-app
   * events to a Firebase / app data stream (KCS3ATPC). Optional —
   * operators opt in with `polaris destinations rotate-secret`, passing a
   * credential that includes the field. When absent, app-source events fall back to
   * the web-stream URL with the synthesized `client_id`; when present
   * AND the mapper produced an `app_instance_id` hint, the deliverer
   * routes via `?firebase_app_id=...&api_secret=...` and stamps
   * `app_instance_id` on the wrapper instead of `client_id`.
   */
  readonly firebase_app_id?: string;
}
