/**
 * Local types for the braze v1 consumer.
 *
 * The mapper produces a `BrazePayload` matching a slice of Braze's
 * `/users/track` request body — one of `attributes[]`, `events[]`, or
 * `purchases[]` is populated per canonical event. The deliverer then
 * POSTs the payload directly to `rest.<instance>.braze.com/users/track`
 * with `Authorization: Bearer <api_key>` (Braze's documented contract).
 *
 * Reference: https://www.braze.com/docs/api/endpoints/user_data/post_user_track
 *
 * Braze's REST API is unversioned through the URL path — `vendor_api_version`
 * is recorded as `rest` in `consumer.manifest.yaml`; semantic breaks bump
 * to a v2 consumer.
 *
 * The runtime never inspects the payload contents — it threads it from
 * the mapper to the deliverer verbatim.
 */

/**
 * Top-level `/users/track` request body slice the mapper produces. At
 * least one of `attributes`, `events`, `purchases` is populated; the
 * deliverer wraps the value as-is into the wire body. Optional fields
 * are intentionally `readonly` + optional so the mapper can omit them
 * when the canonical envelope doesn't carry the data.
 */
export interface BrazePayload {
  readonly attributes?: readonly BrazeAttributeObject[];
  readonly events?: readonly BrazeEventObject[];
  readonly purchases?: readonly BrazePurchaseObject[];
}

/**
 * One entry inside `attributes[]`. Braze keys user-attribute updates on
 * `external_id` (or `braze_id` / `user_alias` for unauthenticated users);
 * v1 only emits `external_id`-keyed entries.
 *
 * `_update_existing_only=false` instructs Braze to create the user
 * profile when one does not exist yet — required for first-touch
 * `user.identified` events to register new users.
 *
 * Additional custom-attribute slots ride alongside the well-known ones
 * (`email`, `phone`, ...). The mapper populates `email` / `phone` from
 * the canonical envelope; future minors may surface more.
 */
export interface BrazeAttributeObject {
  readonly external_id: string;
  readonly email?: string;
  readonly phone?: string;
  readonly _update_existing_only?: boolean;
  /** Locale / country / language slots Braze accepts on attribute updates. */
  readonly country?: string;
  readonly language?: string;
  readonly time_zone?: string;
}

/**
 * One entry inside `events[]`. Braze keys custom events on
 * `external_id` + `name` + `time`. `properties` carries arbitrary
 * receiver-defined key/value pairs (currency, value, page url, ...);
 * the mapper passes through only the slots Braze documents as
 * conventional for the event.
 *
 * `time` is ISO 8601 (Braze's REST contract), not Unix seconds.
 */
export interface BrazeEventObject {
  readonly external_id: string;
  readonly name: string;
  readonly time: string;
  readonly properties?: BrazeEventProperties;
  readonly _update_existing_only?: boolean;
}

/**
 * Free-form key/value bag attached to a custom event. Braze accepts any
 * JSON-serializable value here; v1 emits a narrow set of well-known
 * slots so the wire shape is predictable per canonical event.
 */
export interface BrazeEventProperties {
  readonly currency?: string;
  readonly value?: number;
  readonly cart_id?: string;
  readonly page_url?: string;
  readonly num_items?: number;
}

/**
 * One entry inside `purchases[]`. Braze treats `purchases` as a distinct
 * event family from `events` — they feed revenue attribution + lifetime
 * value differently. The mapper emits one `BrazePurchaseObject` per
 * `payment.approved` canonical event.
 *
 * `product_id` is a Braze-required string identifier for the product;
 * v1 derives it from `cart_id` (or `order_id`) when no `product_id` is
 * directly available — Braze's documentation explicitly notes a single
 * purchase record per transaction is acceptable.
 *
 * `price` is a decimal (NOT minor units); the mapper converts via
 * `minorToMajor` against the canonical currency.
 *
 * `time` is ISO 8601, matching `BrazeEventObject.time`.
 */
export interface BrazePurchaseObject {
  readonly external_id: string;
  readonly product_id: string;
  readonly currency: string;
  readonly price: number;
  readonly time: string;
  readonly quantity?: number;
  readonly properties?: BrazeEventProperties;
  readonly _update_existing_only?: boolean;
}

/**
 * Resolved Braze secret. Pulled from `@polaris/shared-secrets` per
 * delivery attempt; lives in memory only for the duration of one
 * deliverer call.
 *
 * Shape: a JSON document
 *
 *   { "instance": "iad-01", "api_key": "..." }
 *
 * `instance` is the Braze workspace's instance slug (`iad-01`, `iad-02`,
 * `iad-03`, `eu-01`, `eu-02`, ...). It is substituted into the REST host
 * `rest.<instance>.braze.com`. Routing to the wrong instance produces a
 * `failed_permanent` + `auth` outcome.
 *
 * `api_key` is a long-lived REST API key the workspace administrator
 * generates from Braze's "Developer Console". The plaintext key rides
 * as `Authorization: Bearer <api_key>` on every request and is redacted
 * from `vendor_response_summary` defensively.
 */
export interface ResolvedBrazeSecret {
  readonly instance: string;
  readonly api_key: string;
}
