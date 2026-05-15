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
  readonly client_id: string;
  readonly user_id?: string;
  readonly timestamp_micros?: number;
  readonly events: readonly Ga4EventPayload[];
}

/**
 * Resolved GA4 secret. Pulled from `@polaris/shared-secrets` per
 * delivery attempt; lives in memory only for the duration of one
 * deliverer call.
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
}
