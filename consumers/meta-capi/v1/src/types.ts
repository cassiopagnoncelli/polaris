/**
 * Local types for the meta-capi v1 consumer.
 *
 * The mapper produces a `MetaCapiPayload` matching Meta CAPI's request
 * body shape, the deliverer wraps it in `{ data: [payload] }` and POSTs
 * to the Graph API. The runtime never inspects the payload contents.
 *
 * Reference: https://developers.facebook.com/docs/marketing-api/conversions-api/
 * (we target `v22.0`; pinned in `descriptor-identity.ts`).
 */

/**
 * Meta CAPI event payload per the Graph API contract. All identifier
 * fields under `user_data` carry sha256-lowercase-trim values where
 * required by Meta; the shared normalize layer's email + phone helpers
 * produce the correct shape, and the mapper hashes the canonical
 * `customer_id` for `external_id`.
 *
 * Optional fields are intentionally `readonly` + optional so the
 * mapper can omit them when the canonical envelope doesn't carry the
 * data.
 */
export interface MetaCapiPayload {
  /** Vendor event name (`Purchase`, `Lead`, `InitiateCheckout`, ...). */
  readonly event_name: string;
  /** Unix epoch seconds; Meta requires seconds, not milliseconds. */
  readonly event_time: number;
  /**
   * Polaris-stable dedupe key. We pass the canonical `event_id` so Meta
   * deduplicates against the matching browser pixel `eventID` if the
   * customer is running cross-channel (pixel + CAPI).
   */
  readonly event_id: string;
  /**
   * Action source per Meta's enum. The consumer-specific normalize step
   * infers this from `context.source.type` (browser → `website`,
   * mobile → `app`, backend / server → `system_generated`).
   */
  readonly action_source: MetaActionSource;
  /** URL the event happened on. Optional but recommended for `website`. */
  readonly event_source_url?: string;
  /**
   * Hashed + raw identifiers Meta consumes for matching. Email + phone
   * are required to be sha256-lowercase-trim; external_id carries a
   * sha256 of `customer_id`. fbp / fbc are session cookies passed
   * through unchanged.
   */
  readonly user_data: MetaCapiUserData;
  /** Event-specific custom data (currency, value, contents, ...). */
  readonly custom_data?: MetaCapiCustomData;
  /**
   * Opt-out signal per CCPA. Mapped from canonical `consent`:
   * `marketing=false` → `[0]`, otherwise omitted.
   */
  readonly data_processing_options?: readonly string[];
}

/** Meta-defined enum for the `action_source` field. */
export type MetaActionSource =
  | "email"
  | "website"
  | "app"
  | "phone_call"
  | "chat"
  | "physical_store"
  | "system_generated"
  | "other";

/**
 * Meta `user_data` shape. Every field is optional — Meta accepts
 * partial matches and improves match quality as more fields land. The
 * canonical event must provide at least one usable identifier; the
 * normalize layer enforces "no_usable_identity" drops at the boundary.
 */
export interface MetaCapiUserData {
  /** Hashed email(s). Meta accepts an array; we send one entry. */
  readonly em?: readonly string[];
  /** Hashed phone(s) in E.164. */
  readonly ph?: readonly string[];
  /** Hashed external_id(s) — sha256(canonical `customer_id`). */
  readonly external_id?: readonly string[];
  /** Hashed first/last name. v1 does NOT extract these (no canonical slot). */
  readonly fn?: readonly string[];
  readonly ln?: readonly string[];
  /** Browser tracking cookies — passed through verbatim. */
  readonly fbp?: string;
  readonly fbc?: string;
  /** Client IP + UA (Meta uses these for ad-attribution match). */
  readonly client_ip_address?: string;
  readonly client_user_agent?: string;
  /** Customer's anonymized id, sha256-hashed. v1 maps from anonymous_id. */
  readonly anon_id?: string;
}

/**
 * Meta `custom_data` shape. Event-specific; the per-event mapper
 * populates only the fields the canonical envelope carries.
 */
export interface MetaCapiCustomData {
  readonly currency?: string;
  readonly value?: number;
  /** Meta event-specific id (order_id for Purchase, transaction_id for some events). */
  readonly order_id?: string;
  /** Free-form receiver-defined slots; v1 omits them. */
  readonly content_name?: string;
  readonly content_category?: string;
  readonly content_ids?: readonly string[];
  readonly content_type?: string;
  readonly num_items?: number;
  /**
   * Predicted lifetime value (decimal, in `currency` major units). Meta
   * canonically accepts this on subscription / lead-scoring events;
   * the Subscribe and CompleteRegistration mappers populate it when
   * the canonical envelope carries `predicted_ltv` or
   * `predicted_ltv_minor`.
   */
  readonly predicted_ltv?: number;
}

/**
 * The Meta CAPI credential, read from `destinations.secret_value` and handed to
 * the deliverer as `DelivererContext.secret`. Stored plaintext in the control
 * plane; this consumer only ever parses and uses it.
 *
 * Shape: a JSON document
 *
 *   { "pixel_id": "...", "access_token": "...", "test_event_code"?: "..." }
 *
 * `test_event_code` is optional; when present, the deliverer attaches
 * it to the wire payload so the events show up in Meta's "Test Events"
 * dashboard rather than reporting against the live ad-attribution model.
 */
export interface ResolvedMetaCapiSecret {
  readonly pixel_id: string;
  readonly access_token: string;
  readonly test_event_code?: string;
}
