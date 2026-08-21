/**
 * The two boundaries of a participation: what lets a profile in, and what
 * the platform says on the way out.
 *
 * Both are decisions about meaning that the shell would otherwise make
 * while holding a broker. Admission asks whether an arriving event is the
 * trigger a definition declared; emission shapes the `journey.*` event a
 * step produces. Neither reads a store or publishes anything — the
 * orchestrator does that with what it gets back.
 */

import type { JourneyDefinition } from "@polaris/journey-catalog";

import type { JourneyEffect } from "./machine.js";

/**
 * The parts of an arriving event that decide admission.
 *
 * Deliberately narrower than the envelope the orchestrator consumes: a
 * trigger matches on the event NAME and, for an audience trigger, on one
 * property. Taking the whole envelope would make this library's admission
 * rule depend on the spine's wire format, and it does not.
 */
export interface TriggerEvent {
  readonly event: string;
  readonly properties?: Readonly<Record<string, unknown>> | undefined;
}

/** One `journey.*` event to publish, already addressed to a profile. */
export interface OutgoingEffect {
  readonly event: string;
  readonly project_id: string;
  readonly environment: string;
  readonly profile_id: string;
  readonly properties: Record<string, unknown>;
}

/**
 * Whether this event admits a profile to this journey.
 *
 * `audience_entered` matches `audience.entered` carrying the named
 * audience. An `event` trigger matches the event name, and its optional
 * `where` predicate is evaluated by the caller against the profile's
 * traits — not here, because reading traits costs a query and most events
 * match no journey at all.
 */
export function triggerMatches(definition: JourneyDefinition, event: TriggerEvent): boolean {
  const trigger = definition.trigger;
  if (trigger.type === "audience_entered") {
    if (event.event !== "audience.entered") return false;
    return event.properties?.["audience"] === trigger.audience;
  }
  return event.event === trigger.event;
}

/** What a definition's trigger is called, for the `trigger` property. */
export function triggerLabel(definition: JourneyDefinition): string {
  return definition.trigger.type === "audience_entered"
    ? definition.trigger.audience
    : definition.trigger.event;
}

/** Shape a machine effect into the event the orchestrator publishes. */
export function toOutgoing(input: {
  readonly effect: Extract<JourneyEffect, { kind: "emit" }>;
  readonly event: { readonly project_id: string; readonly environment: string };
  readonly definition: JourneyDefinition;
  readonly profileId: string;
  readonly run_id: string;
  readonly triggerLabel: string;
  readonly reEntry: boolean;
}): OutgoingEffect {
  const base = {
    journey: input.definition.key,
    journey_version: input.definition.version,
    profile_id: input.profileId,
    step_id: input.effect.step_id,
    run_id: input.run_id,
  };

  const properties: Record<string, unknown> =
    input.effect.event === "journey.entered"
      ? { ...base, trigger: input.triggerLabel, re_entry: input.reEntry }
      : input.effect.event === "journey.exited"
        ? { ...base, reason: input.effect.reason ?? "completed" }
        : {
            ...base,
            ...(input.effect.from_step_id !== undefined
              ? { from_step_id: input.effect.from_step_id }
              : {}),
            ...(input.effect.properties !== undefined
              ? { properties: input.effect.properties }
              : {}),
          };

  return {
    event: input.effect.event,
    project_id: input.event.project_id,
    environment: input.event.environment,
    profile_id: input.profileId,
    properties,
  };
}
