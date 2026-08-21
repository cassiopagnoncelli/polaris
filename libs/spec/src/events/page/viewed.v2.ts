import { z } from "zod";

/**
 * `page.viewed` v2 — ACTIVE.
 *
 * Splits `path` from `search`, replaces `host` with `referrer`, and adds
 * optional `title`. The split is a version bump because v1 callers used
 * `path` to mean the full pathname plus query; treating their value as
 * v2's `path` would silently change downstream interpretation.
 *
 * `name` and `category` were added in place on 2026-08-21 (no version
 * bump): Segment's `page(category, name)` had no home in Polaris, and the
 * `page()` SDK helper needs somewhere to put them. Both are OPTIONAL keys
 * — `.nullish()`, not the `.nullable()` the original four use — which is
 * what makes the addition in-place: a v2 body written before this change
 * omits them entirely and stays valid.
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
    /**
     * Producer's name for the page (Segment's `page(category, name)`
     * second argument). Distinct from `title`: `title` is what the
     * document said at capture time, `name` is what the producer calls
     * this page in its own taxonomy, and the two diverge whenever the
     * title carries a product name or a cart count.
     */
    name: z.string().min(1).max(256).nullish(),
    /** Producer's grouping for the page (Segment's `page()` first argument). */
    category: z.string().min(1).max(128).nullish(),
  })
  .strict();

export type PageViewedV2Properties = z.infer<typeof pageViewedV2PropertiesSchema>;
