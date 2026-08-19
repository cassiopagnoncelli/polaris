/**
 * Journey definitions — the semantic contract.
 *
 * A journey is a versioned step graph a profile walks: enter on a trigger,
 * wait, branch on what is true of them, emit an action, exit. It is the
 * orchestration layer over everything the platform already concluded —
 * traits, audience membership, the spine's events — and it concludes
 * nothing new itself.
 *
 * ## The orchestrator makes no vendor calls
 *
 * An `action` step emits a `journey.*` event onto the profile plane. That
 * event travels the ordinary destination path — gate, normalize, map,
 * deliver — exactly like `audience.entered` does. The orchestrator has no
 * network access at all.
 *
 * The alternative, an orchestrator that POSTs to Braze itself, would be a
 * second delivery path with its own retry ladder, its own DLQ, its own
 * rate-limit handling and its own idea of what a delivery record is. Two
 * paths to the same vendor is two places to look during an incident and
 * two sets of numbers that will not agree.
 *
 * ## The loop guard is structural, not advisory
 *
 * `journey.*` events can NEVER be a trigger. An action emits
 * `journey.step_advanced`; if that could trigger a journey, a definition
 * could enter a profile into itself — or into a second journey whose
 * action re-enters the first — and the platform would generate events
 * forever at whatever rate the spine can carry.
 *
 * The guard lives in the schema below (`journeyTriggerSchema` rejects the
 * namespace) AND is re-checked in the orchestrator at runtime. Twice on
 * purpose: the loader protects the definitions in this repository, and the
 * runtime protects against an event reaching the orchestrator by any route
 * the loader never saw — a replay, a hand-published message, a future
 * definition source that is not this directory.
 *
 * ## Versioning: participants finish on the version they entered
 *
 * `version` is the graph's revision. Any change to the graph — a step
 * added, a wait shortened, a branch inverted — is a new version. A
 * participant records the version it entered on and walks THAT graph to
 * completion.
 *
 * The alternative, migrating live participants onto a new graph, has no
 * correct answer: a profile parked in a 3-day wait that no longer exists
 * is either dropped mid-journey or teleported to a step it never qualified
 * for. Letting them finish is the only reading that keeps "why did this
 * person get this message" answerable.
 *
 * ## Merges
 *
 * Participants are keyed by `profile_id`. When two profiles merge, the
 * loser's participations are EXITED with reason `merged_away` rather than
 * transferred: the winner may already be participating (transferring would
 * violate the one-participation-per-(journey, profile) key), and a
 * half-walked graph from another identity is not a state the winner ever
 * qualified for. The winner enters on its own merits at the next trigger.
 */

import { type AudiencePredicate, audiencePredicateSchema } from "@polaris/audience-catalog";
import { z } from "zod";

/** Reserved namespace. Nothing in it may ever be a trigger. See the header. */
export const JOURNEY_EVENT_NAMESPACE = "journey." as const;

/** Events the platform emits about a journey's own progress. */
export const JOURNEY_EVENTS = [
  "journey.entered",
  "journey.step_advanced",
  "journey.exited",
] as const;
export type JourneyEvent = (typeof JOURNEY_EVENTS)[number];

/** Keys look like trait and audience keys — one rule across the catalog. */
const keySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,62}[a-z0-9]$/, "key must be lower snake_case");

/** Step ids are keys too, and are unique within a definition. */
const stepIdSchema = keySchema;

/**
 * An event name, for an event trigger.
 *
 * The loop guard. `journey.`-namespaced names are refused here so a
 * definition that would feed its own output back into its own input cannot
 * be written, let alone loaded.
 */
const triggerEventSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, "event must be `domain.name`")
  .refine((event) => !event.startsWith(JOURNEY_EVENT_NAMESPACE), {
    message:
      "journey.* events may never trigger a journey: an action emitting one could re-enter " +
      "its own journey, or a second journey whose action re-enters the first, and the pair " +
      "would generate events forever. See catalog/journeys/types.ts.",
  });

/**
 * What puts a profile into a journey.
 *
 * Two shapes, and deliberately only two. `audience_entered` is the
 * declarative one — a population the platform already maintains — and is
 * what most journeys should use. `event` is the immediate one, for a
 * journey that must react within the same second as something a customer
 * did, where waiting for the audience runner's next pass is too late.
 */
export const journeyTriggerSchema = z
  .union([
    z
      .object({
        type: z.literal("audience_entered"),
        audience: keySchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("event"),
        event: triggerEventSchema,
        /** Optional predicate over the profile's traits at trigger time. */
        where: audiencePredicateSchema.optional(),
      })
      .strict(),
  ])
  .describe("What puts a profile into this journey");

export type JourneyTrigger = z.infer<typeof journeyTriggerSchema>;

/**
 * Whether a profile that has already been through may enter again.
 *
 * `once` is the default because it is the safe one: a journey that sends a
 * welcome series should send it once, and a re-entry bug that sends it
 * nightly is the kind that reaches customers before it reaches a
 * dashboard. `always` and `after_days` are opt-in.
 */
export const journeyReentrySchema = z
  .union([
    z.literal("once"),
    z.literal("always"),
    z.object({ after_days: z.number().int().min(1).max(3650) }).strict(),
  ])
  .describe("Whether a completed participant may enter again");

export type JourneyReentry = z.infer<typeof journeyReentrySchema>;

/**
 * A wait, expressed in whole minutes.
 *
 * Minutes rather than free-form durations because the sweep runs on a
 * crontab and cannot honour a resolution finer than its own period; an
 * author writing `seconds: 30` would be promised something the mechanism
 * cannot deliver. The cap is 90 days: a wait longer than that is a
 * re-trigger, not a wait, and holding a participant row for a year to
 * express it makes the table a scheduling backlog.
 */
const waitMinutesSchema = z.number().int().min(1).max(90 * 24 * 60);

export const journeyStepSchema = z
  .union([
    z
      .object({
        id: stepIdSchema,
        type: z.literal("wait"),
        minutes: waitMinutesSchema,
        /** Where to go when the wait elapses. Omitted means exit. */
        next: stepIdSchema.optional(),
      })
      .strict(),
    z
      .object({
        id: stepIdSchema,
        type: z.literal("branch"),
        /** Evaluated against the profile's traits at the moment it is reached. */
        when: audiencePredicateSchema,
        then: stepIdSchema,
        /** Omitted means exit on the false arm. */
        otherwise: stepIdSchema.optional(),
      })
      .strict(),
    z
      .object({
        id: stepIdSchema,
        type: z.literal("action"),
        /**
         * The `journey.*` event this step emits. Constrained to the
         * namespace: an action emitting `payment.approved` would inject a
         * fact about the customer that no source observed.
         */
        emit: z.enum(JOURNEY_EVENTS),
        /** Free-form payload merged into the emitted event's properties. */
        properties: z.record(z.string(), z.unknown()).optional(),
        next: stepIdSchema.optional(),
      })
      .strict(),
    z
      .object({
        id: stepIdSchema,
        type: z.literal("exit"),
      })
      .strict(),
  ])
  .describe("One node of the graph");

export type JourneyStep = z.infer<typeof journeyStepSchema>;

/** How many steps a journey may have. Bounded so a graph stays readable. */
export const MAX_JOURNEY_STEPS = 64;

export const journeyDefinitionSchema = z
  .object({
    key: keySchema,
    /** Bump on ANY graph change. Participants finish on their entry version. */
    version: z.number().int().min(1),
    description: z.string().min(1).max(500),
    trigger: journeyTriggerSchema,
    reentry: journeyReentrySchema.default("once"),
    /** The step a new participant starts on. */
    start: stepIdSchema,
    steps: z.array(journeyStepSchema).min(1).max(MAX_JOURNEY_STEPS),
  })
  .strict()
  .superRefine((definition, ctx) => {
    const ids = new Set<string>();
    for (const step of definition.steps) {
      if (ids.has(step.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate step id '${step.id}' — one step per id within a journey`,
        });
      }
      ids.add(step.id);
    }

    if (!ids.has(definition.start)) {
      ctx.addIssue({
        code: "custom",
        message: `start step '${definition.start}' is not one of this journey's steps`,
      });
    }

    // Every edge must land somewhere. A dangling `next` is a participant
    // parked forever on a step that cannot advance -- which looks exactly
    // like a long wait, and is the failure an author is least likely to
    // notice in review.
    for (const step of definition.steps) {
      for (const [label, target] of edgesOf(step)) {
        if (target !== undefined && !ids.has(target)) {
          ctx.addIssue({
            code: "custom",
            message: `step '${step.id}' points its '${label}' at '${target}', which does not exist`,
          });
        }
      }
    }

    if (!reachesAnExit(definition)) {
      ctx.addIssue({
        code: "custom",
        message:
          `journey '${definition.key}' has no path from '${definition.start}' that terminates. ` +
          "Every graph must be able to end: a participant on a cycle of waits and branches " +
          "never exits, and its row is held forever.",
      });
    }
  });

export type JourneyDefinition = z.infer<typeof journeyDefinitionSchema>;

/** The outgoing edges of a step, labelled, for validation and traversal. */
export function edgesOf(step: JourneyStep): ReadonlyArray<readonly [string, string | undefined]> {
  switch (step.type) {
    case "wait":
      return [["next", step.next]];
    case "action":
      return [["next", step.next]];
    case "branch":
      return [
        ["then", step.then],
        ["otherwise", step.otherwise],
      ];
    case "exit":
      return [];
    default: {
      const unreachable: never = step;
      throw new Error(`unknown journey step type: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Whether some path from `start` terminates.
 *
 * Termination means reaching an `exit` step or an omitted edge, both of
 * which end the participation. A graph where every path cycles would hold
 * its participants forever; `steps` is capped, so a plain visited-set walk
 * is enough and needs no cycle-length reasoning.
 */
function reachesAnExit(definition: {
  readonly start: string;
  readonly steps: readonly JourneyStep[];
}): boolean {
  const byId = new Map(definition.steps.map((step) => [step.id, step]));
  const seen = new Set<string>();
  const queue = [definition.start];

  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const step = byId.get(id);
    if (step === undefined) continue;
    if (step.type === "exit") return true;
    for (const [, target] of edgesOf(step)) {
      // An omitted edge ends the participation, which is a termination.
      if (target === undefined) return true;
      queue.push(target);
    }
  }
  return false;
}

/** Every trait key a journey's branches read, deduped and sorted. */
export function traitsReferencedByJourney(definition: JourneyDefinition): readonly string[] {
  const keys = new Set<string>();
  const collect = (predicate: AudiencePredicate): void => {
    if ("all" in predicate) for (const p of predicate.all) collect(p);
    else if ("any" in predicate) for (const p of predicate.any) collect(p);
    else if ("not" in predicate) collect(predicate.not);
    else keys.add(predicate.trait);
  };
  if (definition.trigger.type === "event" && definition.trigger.where !== undefined) {
    collect(definition.trigger.where);
  }
  for (const step of definition.steps) {
    if (step.type === "branch") collect(step.when);
  }
  return [...keys].sort();
}
