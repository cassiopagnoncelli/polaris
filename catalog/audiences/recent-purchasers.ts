/**
 * `recent_purchasers` — profiles with at least one order in the last 30 days.
 *
 * The shipped example, and deliberately the simplest useful one: a single
 * comparison against a single trait, whose correctness anyone can check by
 * reading it. A first definition that showed off nested boolean groups
 * would teach the wrong lesson about what belongs in an audience.
 *
 * It reads `orders_30d`, the shipped trait. That layering is the point —
 * the window, the projection it aggregates, and the "no orders" versus "not
 * computed" distinction were all decided once, in the trait, and this
 * audience inherits every one of those decisions instead of restating them.
 *
 * Note what `gte: 1` means given the trait's contract: a profile with no
 * value for `orders_30d` is ABSENT from the trait result, not zero, so it
 * fails this comparison and is not a member. That is the intended reading —
 * "we have not computed this profile" is not "this profile did not buy".
 */

import { type AudienceDefinition, audienceDefinitionSchema } from "./types.js";

export const recentPurchasers: AudienceDefinition = audienceDefinitionSchema.parse({
  key: "recent_purchasers",
  version: 1,
  description: "Profiles with at least one completed order in the last 30 days",
  source: "traits",
  predicate: { trait: "orders_30d", op: "gte", value: 1 },
});
