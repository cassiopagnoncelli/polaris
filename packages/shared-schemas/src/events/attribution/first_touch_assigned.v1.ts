import { z } from "zod";

import {
  attributionCampaignTupleSchema,
  attributionPrimaryIdentifierKindSchema,
} from "./touchpoint_captured.v1.js";

/**
 * `attribution.first_touch_assigned` v1 — ACTIVE.
 *
 * Emitted by `processors/attribution-engine/v1/` the first time a
 * campaign-tagged observation is seen for a
 * `(project_id, environment, primary_identifier)` tuple. v1 applies the
 * conservative deterministic rule: "the first observed touchpoint in
 * the source slice is the first-touch assignment".
 *
 * The processor does NOT decide what constitutes a conversion — that
 * belongs downstream. v1 only surfaces the first observed touchpoint so
 * downstream consumers can attach business-specific conversion semantics.
 *
 * Replay caveat: a replay slice that starts AFTER an identifier's
 * original first touchpoint will produce a fresh first-touch event for
 * whichever touchpoint comes first in the slice. The replay job's
 * `replay.restrictions` and the processor CHANGELOG document this.
 *
 * `touchpoint_id` matches the `attribution.touchpoint_captured` event
 * that originated this assignment so downstream consumers can join the
 * first-touch event back to the raw touchpoint observation.
 */
export const attributionFirstTouchAssignedV1PropertiesSchema = z
  .object({
    /**
     * Touchpoint id of the originating `attribution.touchpoint_captured`
     * event. Format: `tp_<32-hex>`. Replays reproduce identical values.
     */
    touchpoint_id: z
      .string()
      .min(5)
      .max(64)
      .regex(/^tp_[0-9a-f]+$/u, {
        message: "touchpoint_id must be 'tp_<hex>'",
      }),
    /** Kind of identifier the first-touch assignment was keyed on. */
    primary_identifier_kind: attributionPrimaryIdentifierKindSchema,
    /** Value of the primary identifier the first-touch assignment was keyed on. */
    primary_identifier_value: z.string().min(1).max(256),
    /**
     * Campaign tuple recorded as the first touch. Mirrors the originating
     * touchpoint's campaign block.
     */
    campaign: attributionCampaignTupleSchema,
    /**
     * Source event id (UUIDv7) of the original `analytics.events`
     * envelope that triggered the first-touch assignment.
     */
    source_event_id: z.string().min(1).max(128),
    /**
     * ISO 8601 UTC timestamp of the first observation. Mirrors the
     * source event's `occurred_at`.
     */
    observed_at: z.string().datetime({ offset: false }),
    /** Run id of the attribution-engine invocation that recorded the assignment. */
    run_id: z.string().min(1).max(64),
  })
  .strict();

export type AttributionFirstTouchAssignedV1Properties = z.infer<
  typeof attributionFirstTouchAssignedV1PropertiesSchema
>;
