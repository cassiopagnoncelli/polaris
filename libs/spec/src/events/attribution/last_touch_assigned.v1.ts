import { z } from "zod";

import {
  attributionCampaignTupleSchema,
  attributionPrimaryIdentifierKindSchema,
} from "./touchpoint_captured.v1.js";

/**
 * `attribution.last_touch_assigned` v1 — ACTIVE.
 *
 * Emitted by `async/computation/attribution-engine/v1/` whenever the
 * most-recently-observed campaign tuple for a `(project_id, environment,
 * primary_identifier)` tuple changes. The first observed touchpoint
 * also emits a last-touch event because "no prior" is treated as
 * different from any observed tuple. Repeated observations of the same
 * canonical campaign tuple do NOT re-emit (idempotent delta detection
 * on the tuple).
 *
 * v1 deliberately does NOT decide conversions. Downstream analytics
 * joins last-touch events to commerce events on `(project_id,
 * environment, primary_identifier, occurred_at)` using whatever
 * conversion semantics each project defines.
 *
 * Delta detection compares the canonical campaign tuple
 * `(source, medium, name, term, content, click_id)`. Missing/empty
 * fields are normalised to `null` so a producer sending `campaign:
 * { source: null, ... }` is equivalent to `campaign: null` (no
 * touchpoint).
 *
 * `previous_touchpoint_id` is null on the first assignment and
 * populated thereafter so consumers can reconstruct the touchpoint
 * chain without re-reading the touchpoint_captured stream.
 */
export const attributionLastTouchAssignedV1PropertiesSchema = z
  .object({
    /**
     * Touchpoint id of the originating `attribution.touchpoint_captured`
     * event. Format: `tp_<32-hex>`.
     */
    touchpoint_id: z
      .string()
      .min(5)
      .max(64)
      .regex(/^tp_[0-9a-f]+$/u, {
        message: "touchpoint_id must be 'tp_<hex>'",
      }),
    /**
     * Touchpoint id of the immediately-prior last-touch assignment for
     * the same identifier, or null when this is the first assignment.
     * Together with `touchpoint_id` this lets downstream consumers
     * reconstruct the touchpoint chain.
     */
    previous_touchpoint_id: z
      .string()
      .min(5)
      .max(64)
      .regex(/^tp_[0-9a-f]+$/u, {
        message: "previous_touchpoint_id must be 'tp_<hex>'",
      })
      .nullable(),
    /** Kind of identifier the last-touch assignment was keyed on. */
    primary_identifier_kind: attributionPrimaryIdentifierKindSchema,
    /** Value of the primary identifier the last-touch assignment was keyed on. */
    primary_identifier_value: z.string().min(1).max(256),
    /**
     * Campaign tuple recorded as the new last touch. Differs from the
     * previous assignment's tuple by at least one field (the delta
     * detector enforces this).
     */
    campaign: attributionCampaignTupleSchema,
    /**
     * Source event id (UUIDv7) of the `analytics.events` envelope that
     * triggered the assignment.
     */
    source_event_id: z.string().min(1).max(128),
    /**
     * ISO 8601 UTC timestamp of the observation that produced the
     * assignment. Mirrors the source event's `occurred_at`.
     */
    observed_at: z.string().datetime({ offset: false }),
    /** Run id of the attribution-engine invocation that recorded the assignment. */
    run_id: z.string().min(1).max(64),
  })
  .strict();

export type AttributionLastTouchAssignedV1Properties = z.infer<
  typeof attributionLastTouchAssignedV1PropertiesSchema
>;
