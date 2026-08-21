/**
 * Local types for the ga4 v1 consumer.
 *
 * The mapper produces a `Ga4EventPayload` matching one entry inside the
 * GA4 Measurement Protocol request body's `events[]` array; the
 * deliverer wraps the payload in
 * `{ client_id, user_id?, timestamp_micros?, events: [payload] }` and
 * POSTs it to `https://www.google-analytics.com/mp/collect?measurement_id=<id>&api_secret=<secret>`.
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
 * Optional fields are intentionally `readonly` + optional so the mapper
 * can omit them when the canonical envelope doesn't carry the data.
 */
export interface Ga4EventPayload {
  /** Vendor event name (`purchase`, `begin_checkout`, `login`, ...). */
  readonly name: string;
  /** Event-specific params (currency, value, transaction_id, ...). */
  readonly params?: Ga4EventParams;
  /**
   * Polaris-internal wrapper hint (KCS3ATPC). When populated, the
   * deliverer lifts this value to the request-wrapper `app_instance_id`
   * slot and strips it from the per-event payload before serializing —
   * GA4 Measurement Protocol carries `app_instance_id` at the request
   * level for Firebase / app streams (not on individual events).
   * Synthesized by the mapper from `context.app_idfv` / `context.app_gaid`
   * when the canonical envelope reports an app source.
   */
  readonly app_instance_id?: string;
  /**
   * Side channel, like `app_instance_id` above: the deliverer lifts this to
   * the request wrapper's `client_id` and it never appears inside the
   * `events[]` entry. Resolved by the mapper, which is the only stage that
   * can see the canonical identity.
   *
   * REQUIRED, deliberately. As an optional slot the deliverer needed a
   * fallback, the only sane fallback was the `delivery_key` synthesis this
   * change exists to delete, and that fallback silently reinstated the old
   * behaviour for any payload built by hand — including the two deliverer
   * tests that were asserting it. A required field makes the mapper the
   * single place a `client_id` can come from.
   */
  readonly client_id: string;
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
  /** GA4 stitches sessions via the `engagement_time_msec` param when present. */
  readonly engagement_time_msec?: number;
  readonly session_id?: string;
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
 * `client_id` is required by GA4 (it is the property's session-stitch
 * key); `user_id` is optional. `timestamp_micros` is microseconds since
 * the Unix epoch.
 */
export interface Ga4RequestBody {
  /**
   * GA4 stream identifier at the wrapper level. EXACTLY ONE of
   * `client_id` (web-stream, Measurement Protocol) or `app_instance_id`
   * (Firebase / app-stream) is set per request — GA4's two URL flavors
   * key on different wrapper identifiers. The deliverer chooses based
   * on the resolved secret (`measurement_id` vs `firebase_app_id`) and
   * the mapper-supplied `Ga4EventPayload.app_instance_id` hint.
   */
  readonly client_id?: string;
  readonly app_instance_id?: string;
  readonly user_id?: string;
  readonly timestamp_micros?: number;
  readonly events: readonly Ga4EventPayload[];
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
