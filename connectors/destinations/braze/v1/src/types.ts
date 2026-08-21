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
export interface BrazeUserAlias {
  /** Closed set in v1: `"email"` or `"phone"`. */
  readonly alias_label: string;
  /** Raw alias value — Braze accepts unhashed alias names. */
  readonly alias_name: string;
}

export interface BrazeAttributeObject {
  /**
   * Canonical `customer_id` (lowercased, trimmed). Required when no
   * `user_alias` AND no `device_id` is supplied. The mapper emits
   * exactly one of `external_id` / `user_alias` / `device_id` as the
   * primary identifier per entry; Braze rejects entries with zero.
   * When the event is app-source AND an external_id is also resolvable
   * the mapper attaches `device_id` ALONGSIDE `external_id` so Braze
   * stitches the anonymous device session to the identified profile.
   */
  readonly external_id?: string;
  readonly user_alias?: BrazeUserAlias;
  /**
   * Mobile-app device identifier (5UCTHNCR). Synthesized from the
   * canonical `context.app_idfv` / `context.app_gaid` slot when the
   * canonical envelope reports an app source.
   */
  readonly device_id?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly _update_existing_only?: boolean;
  /** Locale / country / language slots Braze accepts on attribute updates. */
  readonly country?: string;
  readonly language?: string;
  readonly time_zone?: string;
  /**
   * The standard profile fields the trait snapshot fills (STHB0). Declared
   * here rather than left to the custom-attribute bag because Braze OWNS
   * these names: `dob` is `YYYY-MM-DD`, `gender` is one of `M`/`F`/`O`/`N`/
   * `P`, `home_city` is a city name and `image_url` is the profile picture
   * the dashboard renders. A value of the wrong shape in one of them is a
   * vendor 400, not a junk custom attribute, so the shape belongs in the
   * type.
   */
  readonly first_name?: string;
  readonly last_name?: string;
  readonly dob?: string;
  readonly gender?: string;
  readonly home_city?: string;
  readonly image_url?: string;
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
  /**
   * Canonical `customer_id` (lowercased, trimmed). Required when no
   * `user_alias` AND no `device_id` is supplied. See
   * `BrazeAttributeObject` for the full identifier ladder.
   */
  readonly external_id?: string;
  readonly user_alias?: BrazeUserAlias;
  /**
   * Mobile-app device identifier (5UCTHNCR). Synthesized from the
   * canonical `context.app_idfv` / `context.app_gaid` slot when the
   * canonical envelope reports an app source. Anchors the event to a
   * specific device when no `external_id` / `user_alias` resolves
   * (anonymous app session) and rides alongside `external_id` when one
   * does (logged-in mobile user).
   */
  readonly device_id?: string;
  readonly name: string;
  readonly time: string;
  readonly properties?: BrazeEventProperties | BrazeJourneyEventProperties;
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
 * Properties on a `polaris_journey_step` custom event.
 *
 * The one place the "narrow well-known slots" rule above is relaxed, and
 * deliberately confined to its own type rather than loosened on
 * {@link BrazeEventProperties}. An action step's payload is author-defined
 * — `definitions/journeys` decides what `message: "thank_you_repeat"` is, and
 * the orchestrator carries it through uninterpreted — so this event cannot
 * have a closed slot set the way `checkout.started` can.
 *
 * Putting the index signature on the shared type instead would buy that
 * flexibility at the cost of every other mapper: `properties.currncy = x`
 * would typecheck, and a typo'd slot silently reaching a vendor is the
 * failure the closed set exists to prevent.
 *
 * Primitives only. Braze rejects nested objects in custom-event
 * properties, and the mapper drops anything else rather than producing a
 * 400 the runtime records as a delivery failure.
 */
export interface BrazeJourneyEventProperties {
  readonly journey: string;
  readonly step_id: string;
  readonly journey_version?: number;
  readonly [key: string]: string | number | boolean | undefined;
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
  /**
   * Canonical `customer_id` (lowercased, trimmed). Required when no
   * `user_alias` AND no `device_id` is supplied. See
   * `BrazeAttributeObject` for the full identifier ladder.
   */
  readonly external_id?: string;
  readonly user_alias?: BrazeUserAlias;
  /**
   * Mobile-app device identifier (5UCTHNCR). Same semantics as
   * `BrazeEventObject.device_id`.
   */
  readonly device_id?: string;
  readonly product_id: string;
  readonly currency: string;
  readonly price: number;
  readonly time: string;
  readonly quantity?: number;
  readonly properties?: BrazeEventProperties;
  readonly _update_existing_only?: boolean;
}

/**
 * The Braze credential, read from `destinations.secret_value` and handed to
 * the deliverer as `DelivererContext.secret`. Stored plaintext in the control
 * plane; this consumer only ever parses and uses it.
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
