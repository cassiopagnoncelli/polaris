import { z } from "zod";

/**
 * `page.viewed` v1 — DEPRECATED.
 *
 * Original shape produced by early Web SDK builds. v2 splits the URL into
 * `path` plus an optional `search` and adds `referrer`, which is a
 * downstream-breaking change (renaming/restructuring counts as a version
 * bump per `01-event-contract.md` § Schema Evolution). v1 remains in the
 * catalog until its `sunset_at` so historical events in `raw.events` stay
 * replayable.
 */
export const pageViewedV1PropertiesSchema = z
  .object({
    /** Full pathname including query string (legacy). */
    path: z.string().min(1).max(2048),
    /** Page title at the moment the event was captured. */
    title: z.string().max(512).nullish(),
    /** Host portion of the URL (dropped in v2 — derive from `context.page` instead). */
    host: z.string().max(256).nullish(),
  })
  .strict();

export type PageViewedV1Properties = z.infer<typeof pageViewedV1PropertiesSchema>;
