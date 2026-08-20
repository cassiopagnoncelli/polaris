/**
 * `welcome_recent_purchasers` — the shipped example.
 *
 * Deliberately the simplest journey that exercises every step type once:
 * enter from an audience, wait a day, branch on a trait, act, exit. Its
 * correctness is checkable by reading it, which is what an example is for.
 *
 * It triggers on `recent_purchasers` rather than on `payment.approved`
 * directly, and that choice is the point of having both trigger shapes.
 * The audience is a population the platform already maintains, with a
 * definition and a version of its own; a journey that re-derived "has
 * ordered recently" from an event predicate would be a second answer to a
 * question already answered, free to disagree with the first.
 */

import { journeyDefinitionSchema, type JourneyDefinition } from "./types.js";

export const welcomeRecentPurchasers: JourneyDefinition = journeyDefinitionSchema.parse({
  key: "welcome_recent_purchasers",
  version: 1,
  description: "Thank a customer a day after they join the recent-purchasers audience",
  trigger: { type: "audience_entered", audience: "recent_purchasers" },
  // Once. A thank-you that arrives every time the audience runner
  // reconfirms membership is the failure mode that reaches customers
  // before it reaches a dashboard.
  reentry: "once",
  start: "settle",
  steps: [
    {
      // A day, so the message does not land in the same minute as the
      // order confirmation the vendor already sent.
      id: "settle",
      type: "wait",
      minutes: 24 * 60,
      next: "is_repeat_customer",
    },
    {
      // Read at the moment the branch is REACHED, not at entry: a day has
      // passed, and what is true of the profile may have changed. That is
      // the whole reason a branch is a step rather than an entry condition.
      id: "is_repeat_customer",
      type: "branch",
      when: { trait: "orders_30d", op: "gte", value: 2 },
      matched: "thank_repeat",
      otherwise: "thank_first",
    },
    {
      id: "thank_repeat",
      type: "action",
      emit: "journey.step_advanced",
      properties: { message: "thank_you_repeat" },
      next: "done",
    },
    {
      id: "thank_first",
      type: "action",
      emit: "journey.step_advanced",
      properties: { message: "thank_you_first" },
      next: "done",
    },
    { id: "done", type: "exit" },
  ],
});
