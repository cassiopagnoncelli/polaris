/**
 * Local types for the tiktok v1 consumer.
 *
 * The mapper produces a `TikTokEventPayload` matching one entry inside
 * TikTok Events API's `data[]` array; the deliverer wraps the payload
 * in `{ event_source, event_source_id, data: [payload], test_event_code? }`
 * and POSTs it to `event/track/`. The runtime never inspects the payload
 * contents.
 *
 * Reference: https://business-api.tiktok.com/portal/docs?id=1771101303285761
 * (we target `v1.3`; pinned in `descriptor-identity.ts`).
 */

/**
 * TikTok Events API per-event payload shape per the v1.3 contract.
 * Lives inside `data[]` in the request body; the deliverer wraps the
 * array with `event_source` + `event_source_id` (the pixel id) before
 * POSTing.
 *
 * All identifier fields under `user` carry sha256-lowercase-trim values
 * where required by TikTok; the shared normalize layer's email + phone
 * helpers produce the correct shape, and the mapper hashes the canonical
 * `customer_id` for `external_id`.
 *
 * Optional fields are intentionally `readonly` + optional so the mapper
 * can omit them when the canonical envelope doesn't carry the data.
 */
export interface TikTokEventPayload {
  /** Vendor event name (`Purchase`, `CompleteRegistration`, `InitiateCheckout`, ...). */
  readonly event: string;
  /** Unix epoch seconds; TikTok requires seconds, not milliseconds. */
  readonly event_time: number;
  /**
   * Polaris-stable dedupe key. We pass the canonical `event_id` so
   * TikTok deduplicates against the matching browser-pixel `event_id` if
   * the customer is running cross-channel (pixel + Events API).
   */
  readonly event_id: string;
  /**
   * Hashed + raw identifiers TikTok consumes for matching. `email` /
   * `phone` are required to be sha256-lowercase-trim; `external_id`
   * carries a sha256 of `customer_id`. `ttp` / `ttclid` are TikTok
   * tracking cookies passed through unchanged.
   */
  readonly user: TikTokUserData;
  /** Event-specific properties (currency, value, contents, ...). */
  readonly properties?: TikTokEventProperties;
  /**
   * URL the event happened on. TikTok labels this `page.url` and
   * recommends populating it for web-source events.
   */
  readonly page?: TikTokPageContext;
  /**
   * Limited Data Use signal per CCPA. Mapped from canonical `consent`:
   * `marketing=false` → `1`, otherwise omitted. TikTok's flag is named
   * `limited_data_use`.
   */
  readonly limited_data_use?: 0 | 1;
}

/**
 * TikTok `user` shape. Every field is optional — TikTok accepts partial
 * matches and improves match quality as more fields land. The canonical
 * event must provide at least one usable identifier; the normalize
 * layer enforces "no_usable_identity" drops at the boundary.
 */
export interface TikTokUserData {
  /** Hashed email (sha256-lowercase-trim hex). */
  readonly email?: string;
  /** Hashed phone (E.164 + sha256 hex). */
  readonly phone?: string;
  /** Hashed external_id — sha256(canonical `customer_id`). */
  readonly external_id?: string;
  /** Hashed first/last name. v1 does NOT extract these (no canonical slot). */
  readonly first_name?: string;
  readonly last_name?: string;
  /** Client IP + UA (TikTok uses these for ad-attribution match). */
  readonly ip?: string;
  readonly user_agent?: string;
  /** Anonymized id, sha256-hashed. v1 maps from `anonymous_id`. */
  readonly ttclid?: string;
  /** TikTok pixel cookie passed through verbatim. */
  readonly ttp?: string;
  /** Locale (e.g. en-US). */
  readonly locale?: string;
}

/**
 * TikTok `properties` shape. Event-specific; the per-event mapper
 * populates only the fields the canonical envelope carries.
 *
 * `contents[]` is TikTok's product-detail array (sku, quantity, price);
 * v1 emits it when canonical `properties.items[]` is present.
 */
export interface TikTokEventProperties {
  readonly currency?: string;
  readonly value?: number;
  /** Vendor-side order/transaction id (canonical `order_id` / `cart_id`). */
  readonly order_id?: string;
  /** Per-product detail array. */
  readonly contents?: readonly TikTokEventContent[];
  /** Free-form receiver-defined slots; v1 omits them. */
  readonly content_type?: string;
  readonly content_name?: string;
  readonly content_category?: string;
  readonly description?: string;
  readonly num_items?: number;
}

/**
 * One entry inside `properties.contents[]`. TikTok recommends shipping
 * one entry per cart line item with `content_id` + `quantity` +
 * `price`. The v1 mapper omits names/categories until a canonical slot
 * carries them.
 */
export interface TikTokEventContent {
  readonly content_id?: string;
  readonly content_name?: string;
  readonly content_category?: string;
  readonly content_type?: string;
  readonly brand?: string;
  readonly price?: number;
  readonly quantity?: number;
}

/** TikTok page-context block. Mirrors a small slice of the canonical context. */
export interface TikTokPageContext {
  readonly url?: string;
  readonly referrer?: string;
}

/**
 * TikTok-defined `event_source` enum (request-level, not per-payload).
 * The deliverer stamps the enum on the wire wrapper; the mapper's
 * `inferEventSource` keeps the inference uniform per canonical event.
 */
export type TikTokEventSource = "web" | "app" | "crm" | "offline";

/**
 * Resolved TikTok secret. Pulled from `@polaris/shared-secrets` per
 * delivery attempt; lives in memory only for the duration of one
 * deliverer call.
 *
 * Shape: a JSON document
 *
 *   { "access_token": "...", "pixel_id": "...", "test_event_code"?: "..." }
 *
 * `test_event_code` is optional; when present, the deliverer attaches
 * it to the wire payload so the events show up in TikTok's "Test
 * Events" debugger rather than reporting against the live ad-attribution
 * model.
 */
export interface ResolvedTikTokSecret {
  readonly access_token: string;
  readonly pixel_id: string;
  readonly test_event_code?: string;
}
