import { z } from "zod";

/**
 * `page.viewed` v2 — ACTIVE.
 *
 * Splits `path` from `search`, replaces `host` with `referrer`, and adds
 * optional `title`. The split is a version bump because v1 callers used
 * `path` to mean the full pathname plus query; treating their value as
 * v2's `path` would silently change downstream interpretation.
 */
export const pageViewedV2PropertiesSchema = z
  .object({
    /** URL pathname without the query string. */
    path: z.string().min(1).max(2048),
    /** Query string portion including leading `?`, or null when absent. */
    search: z.string().max(2048).nullable(),
    /** Page title at the moment the event was captured. */
    title: z.string().max(512).nullable(),
    /** Document referrer URL, or null when not available. */
    referrer: z.string().max(2048).nullable(),
  })
  .strict();

export type PageViewedV2Properties = z.infer<typeof pageViewedV2PropertiesSchema>;
