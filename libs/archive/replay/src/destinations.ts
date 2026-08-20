/**
 * Which topic families a replay can reach vendor destinations through.
 *
 * ## Why this exists
 *
 * `docs/architecture/11-production-readiness.md` states that destination
 * sends are disabled by default during a replay and need explicit opt-in.
 * That was not true. The planner computed `destinations_enabled` only when
 * `target === "destinations"`, but the executor publishes to the plan's
 * `source_topic_family`, which the planner hardcodes to `raw.events` for
 * **every** target. So a `target: "analytics_raw"`, `mode: "live"` replay
 * republished into `raw.events`, flowed through the processors into
 * `analytics.events`, and was delivered to Braze, GA4, Meta CAPI and TikTok —
 * real calls about real people — carrying `destinations_enabled: false`, no
 * `destination_sends_enabled` risk flag, and no opt-in note required.
 *
 * The mistake was treating destination reachability as a property of the
 * operator's stated *target* rather than of the topic the executor actually
 * publishes to. It is the latter: whatever you put on a family that feeds the
 * destination consumers gets delivered, regardless of why you say you are
 * replaying.
 *
 * ## The delivery path this encodes
 *
 *   raw.events ──(sync/legacy/analytics-projector)──▶ analytics.events
 *                                                          │
 *                                     (consumers/{braze,ga4,meta-capi,
 *                                      tiktok,webhook-sink})
 *                                                          ▼
 *                                                   vendor APIs
 *
 * Destination consumers subscribe to `analytics.events`
 * (`libs/delivery/destinations/src/runtime.ts`). `analytics-projector`
 * reads `raw.events` and writes `analytics.events`
 * (`sync/legacy/analytics-projector/v1/src/runtime.ts`). So both families
 * reach vendors; the other derived families have no destination consumer.
 *
 * This is deliberately conservative: it asks whether delivery is *possible*,
 * not whether a given project currently has an active destination. A replay
 * plan should not become unsafe because someone enabled a destination between
 * planning and execution.
 */

/**
 * Topic families whose contents reach vendor destinations.
 *
 * Kept as a literal rather than derived from `@polaris/shared-transport` so
 * this package stays dependency-free — it is a pure planner. The trade is
 * that a new destination-feeding family must be added here too.
 *
 * ## This was wrong from the M6 retirement until 2026-08-19
 *
 * It listed `analytics.events`, decommissioned by 126EPNIQ, and omitted BOTH
 * families destinations actually read. `topicFamilyReachesDestinations`
 * answered `false` for `resolved.events` — the spine every vendor consumes —
 * so a replay targeting it recorded `reachesDestinations: false` on its audit
 * row while reaching all five vendors. A safety signal that is confidently
 * inverted is worse than an absent one.
 *
 * The old comment claimed "the test suite pins the current set so the
 * omission is loud". It did pin the set — to the wrong answer, as a literal
 * with no tie to what destinations declare, so it passed through the
 * retirement unchanged. `destinations.test.ts` now reads the consumers'
 * own `inputFamily` declarations, which is the only version of that promise
 * that can keep it.
 */
const DESTINATION_REACHING_FAMILIES: ReadonlySet<string> = new Set([
  // Replay's default target. It re-enters the spine at stage 1, so it
  // reaches destinations transitively through identity and enrichment.
  "raw.events",
  // The spine. Read directly by all five destination consumers.
  "resolved.events",
  // The profile plane. Read by braze and webhook-sink, which act on
  // audience membership and journey steps.
  "profile.events",
]);

/**
 * Whether publishing to this family can result in vendor delivery.
 *
 * Project-scoped isolation topics (`<family>.<project_id>`) are the same
 * family for this purpose — an isolated project still has consumers.
 */
export function topicFamilyReachesDestinations(topicFamily: string): boolean {
  const trimmed = topicFamily.trim();
  if (DESTINATION_REACHING_FAMILIES.has(trimmed)) return true;
  // `analytics.events.storefront` is an isolated `analytics.events`.
  for (const family of DESTINATION_REACHING_FAMILIES) {
    if (trimmed.startsWith(`${family}.`)) return true;
  }
  return false;
}

/** The families that reach destinations, for tests and error messages. */
export function destinationReachingFamilies(): readonly string[] {
  return [...DESTINATION_REACHING_FAMILIES];
}
