import { z } from "zod";

/**
 * `attribution.touchpoint_captured` v1 — ACTIVE.
 *
 * Emitted by `processors/attribution-engine/v1/` once per source
 * `analytics.events` envelope whose `context.campaign` block carries at
 * least one non-null field. The event records that a campaign-tagged
 * observation was seen for a `(project_id, environment,
 * primary_identifier)` tuple.
 *
 * v1 takes a conservative deterministic stance: the SDK captures
 * campaign/click context (per `docs/architecture/10-sdk-standards.md`,
 * "Capture campaign/click context because persistent identity may fail
 * in WebViews") but does NOT interpret attribution. The processor only
 * surfaces what the SDK observed. Whether a touchpoint becomes a
 * "conversion" is downstream business logic — out of scope for v1.
 *
 * `touchpoint_id` is derived deterministically from
 * `(source_event_id, campaign_tuple)` so replays produce identical
 * identifiers byte-for-byte.
 *
 * The campaign tuple uses the same field shape as the canonical envelope's
 * `context.campaign` block (mirrors `envelope/primitives.ts`
 * `campaignContextSchema`). Field semantics intentionally match the
 * standard UTM vocabulary so v1 does not invent vendor-specific
 * destination semantics.
 */

/**
 * Kinds of identifier the attribution engine recognises in v1. Mirrors
 * the sessionizer's preference order so a session and its attribution
 * touchpoints key on the same identifier.
 */
export const attributionPrimaryIdentifierKindSchema = z.enum([
  "customer_id",
  "anonymous_id",
  "session_id",
]);
export type AttributionPrimaryIdentifierKind = z.infer<
  typeof attributionPrimaryIdentifierKindSchema
>;

/**
 * Canonical campaign tuple shape. Mirrors the envelope's
 * `context.campaign` block but with all fields normalised to `string |
 * null` (no nullish flicker). v1 fields are exactly the SDK-captured set.
 *
 * The Zod schema validates each field's max length so a malformed
 * upstream envelope cannot bloat downstream rows. Empty strings are
 * normalised to `null` upstream by the processor's transform.
 */
export const attributionCampaignTupleSchema = z
  .object({
    /** UTM `source` — e.g. `google`, `newsletter`. */
    source: z.string().min(1).max(128).nullable(),
    /** UTM `medium` — e.g. `cpc`, `email`, `referral`. */
    medium: z.string().min(1).max(128).nullable(),
    /** UTM `campaign` — e.g. `summer_sale_2026`. */
    name: z.string().min(1).max(256).nullable(),
    /** UTM `term` — paid-search keyword. */
    term: z.string().min(1).max(256).nullable(),
    /** UTM `content` — ad creative or A/B variant tag. */
    content: z.string().min(1).max(256).nullable(),
    /**
     * Click identifier — vendor-agnostic catch-all for `gclid`, `fbclid`,
     * `msclkid`, etc. The SDK captures whichever one the inbound URL
     * carried and stores it verbatim. v1 does NOT split this into
     * per-vendor fields (that would be vendor-specific destination logic,
     * which the processor forbids).
     */
    click_id: z.string().min(1).max(256).nullable(),
  })
  .strict();

export type AttributionCampaignTuple = z.infer<typeof attributionCampaignTupleSchema>;

export const attributionTouchpointCapturedV1PropertiesSchema = z
  .object({
    /**
     * Deterministic touchpoint identifier derived from
     * `(source_event_id, campaign_tuple)` via SHA-256. Replays produce
     * the same value byte-for-byte. Format: `tp_<32-hex>` so the prefix
     * disambiguates from session ids (`sess_`) and identity link ids.
     */
    touchpoint_id: z
      .string()
      .min(5)
      .max(64)
      .regex(/^tp_[0-9a-f]+$/u, {
        message: "touchpoint_id must be 'tp_<hex>'",
      }),
    /**
     * Kind of identifier the touchpoint was keyed on. Preference order
     * applied by v1: customer_id > anonymous_id > session_id.
     */
    primary_identifier_kind: attributionPrimaryIdentifierKindSchema,
    /** Value of the primary identifier the touchpoint was keyed on. */
    primary_identifier_value: z.string().min(1).max(256),
    /**
     * Campaign tuple captured on this observation. At least one field is
     * non-null by construction (the processor drops events whose
     * campaign block is entirely empty).
     */
    campaign: attributionCampaignTupleSchema,
    /**
     * Source event id (UUIDv7) the touchpoint was derived from. Useful
     * for lineage queries — the touchpoint joins back to the analytics
     * event that carried the campaign context.
     */
    source_event_id: z.string().min(1).max(128),
    /**
     * ISO 8601 UTC timestamp from the source event's `occurred_at`. The
     * touchpoint event mirrors this onto its own `occurred_at` for
     * downstream timeline joins.
     */
    observed_at: z.string().datetime({ offset: false }),
    /** Run id of the attribution-engine invocation that recorded the touchpoint. */
    run_id: z.string().min(1).max(64),
  })
  .strict();

export type AttributionTouchpointCapturedV1Properties = z.infer<
  typeof attributionTouchpointCapturedV1PropertiesSchema
>;
