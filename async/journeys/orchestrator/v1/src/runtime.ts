/**
 * The orchestrator's message loop.
 *
 * Consumes `resolved.events` and `profile.events`, decides whether each
 * one admits a profile to a journey, and publishes what the engine says
 * happened. It owns no journey semantics: the engine decides, the
 * repository stores, this moves bytes between them.
 *
 * ## It subscribes to the profile plane, which is where the loop guard bites
 *
 * `audience.entered` — the declarative trigger — rides `profile.events`,
 * and so do the `journey.*` events this service itself emits. So every
 * message it publishes comes back to it. That is not a design accident to
 * be routed around; it is why the loop guard exists, and why it is checked
 * here on the way IN rather than only in the catalog.
 *
 * A `journey.*` event is dropped before any definition is consulted. The
 * catalog cannot express a definition that would match one, but the
 * catalog only governs definitions in this repository — a replay, a
 * hand-published message, or a future definition source reaches this loop
 * without passing it.
 *
 * ## Effects are published after state is written
 *
 * The engine returns effects; the repository is updated first, then the
 * events go out. The ordering matters and only one direction is
 * recoverable: publishing first and crashing would emit
 * `journey.step_advanced` for a move that never persisted, and a
 * destination would act on it — a vendor message for a step the
 * participant is not on. Writing first and crashing loses the event, and
 * the participant's row still says where it is.
 */

import type { JourneyDefinition } from "@polaris/journey-catalog";
import type { Logger } from "@polaris/observability-logger";
import { v7 as uuidv7 } from "uuid";
import type { ProfileSnapshot } from "./engine.js";
import {
  advance,
  evaluatePredicate,
  isForbiddenTrigger,
  type JourneyEffect,
  mayReenter,
} from "./engine.js";
import type { JourneyRepository } from "./repository.js";

export const PROCESSOR_NAME = "journey-orchestrator" as const;
export const PROCESSOR_VERSION = "v1" as const;

/** The envelope fields this service reads. */
export interface IncomingEvent {
  readonly event_id: string;
  readonly event: string;
  readonly project_id: string;
  readonly environment: string;
  readonly occurred_at: string;
  readonly profile?: { readonly profile_id?: string } | undefined;
  readonly properties?: Record<string, unknown> | undefined;
}

/** One `journey.*` event to publish, already addressed to a profile. */
export interface OutgoingEffect {
  readonly event: string;
  readonly project_id: string;
  readonly environment: string;
  readonly profile_id: string;
  readonly properties: Record<string, unknown>;
}

export interface HandleEventDeps {
  readonly definitions: readonly JourneyDefinition[];
  readonly repository: JourneyRepository;
  readonly readProfile: (input: {
    readonly project_id: string;
    readonly environment: string;
    readonly profile_id: string;
  }) => Promise<ProfileSnapshot>;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly newId?: () => string;
  readonly run_id: string;
}

export interface HandleEventResult {
  /** Why nothing happened, when nothing did. Useful in tests and logs. */
  readonly skipped?:
    | "forbidden_trigger"
    | "no_profile"
    | "no_matching_journey"
    | "already_participating"
    | "reentry_refused";
  readonly published: readonly OutgoingEffect[];
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
export function triggerMatches(definition: JourneyDefinition, event: IncomingEvent): boolean {
  const trigger = definition.trigger;
  if (trigger.type === "audience_entered") {
    if (event.event !== "audience.entered") return false;
    return event.properties?.["audience"] === trigger.audience;
  }
  return event.event === trigger.event;
}

export async function handleEvent(
  event: IncomingEvent,
  deps: HandleEventDeps,
): Promise<HandleEventResult> {
  // The loop guard, on the way in. See the module header: this service
  // consumes the plane it publishes to, so its own output reaches it.
  if (isForbiddenTrigger(event.event)) {
    return { skipped: "forbidden_trigger", published: [] };
  }

  const profileId = event.profile?.profile_id;
  if (profileId === undefined || profileId === "") {
    // A journey is about a person. An event the identity stage could not
    // resolve has nobody to admit, and inventing a participant keyed on
    // nothing would be worse than dropping it.
    return { skipped: "no_profile", published: [] };
  }

  const candidates = deps.definitions.filter((definition) => triggerMatches(definition, event));
  if (candidates.length === 0) return { skipped: "no_matching_journey", published: [] };

  const newId = deps.newId ?? (() => `polaris_jp_${uuidv7()}`);
  const now = deps.now();
  const published: OutgoingEffect[] = [];
  let lastSkip: HandleEventResult["skipped"];

  // Traits are read once, lazily, and shared by every candidate: an event
  // matching three journeys should cost one profile read, not three.
  let profile: ProfileSnapshot | undefined;
  const profileOnce = async (): Promise<ProfileSnapshot> => {
    profile ??= await deps.readProfile({
      project_id: event.project_id,
      environment: event.environment,
      profile_id: profileId,
    });
    return profile;
  };

  for (const definition of candidates) {
    if (definition.trigger.type === "event" && definition.trigger.where !== undefined) {
      const snapshot = await profileOnce();
      if (!evaluatePredicate(definition.trigger.where, snapshot.traits)) continue;
    }

    const lastExitedAt = await deps.repository.lastExitedAt({
      project_id: event.project_id,
      environment: event.environment,
      journey: definition.key,
      profile_id: profileId,
    });
    if (!mayReenter({ definition, lastExitedAt, now })) {
      lastSkip = "reentry_refused";
      continue;
    }

    const entered = await deps.repository.enterIfAbsent({
      id: newId(),
      project_id: event.project_id,
      environment: event.environment,
      journey: definition.key,
      journey_version: definition.version,
      profile_id: profileId,
      step_id: definition.start,
    });

    if (entered === "already_participating") {
      // The normal outcome for a redelivered trigger, and the reason entry
      // is an INSERT against a unique index rather than a check-then-write.
      lastSkip = "already_participating";
      continue;
    }

    const result = advance({
      definition,
      participation: {
        journey: definition.key,
        journey_version: definition.version,
        profile_id: profileId,
        step_id: definition.start,
      },
      profile: await profileOnce(),
      now,
      justEntered: true,
    });

    // State first, then events. See the module header: the other order
    // emits an advance that never persisted, and a destination acts on it.
    await applyToRepository({
      repository: deps.repository,
      participantId: entered.id,
      effects: result.effects,
      restingStepId: result.restingStepId,
      now,
    });

    for (const effect of result.effects) {
      if (effect.kind !== "emit") continue;
      published.push(
        toOutgoing({
          effect,
          event,
          definition,
          profileId,
          run_id: deps.run_id,
          triggerLabel:
            definition.trigger.type === "audience_entered"
              ? definition.trigger.audience
              : definition.trigger.event,
          reEntry: lastExitedAt !== null,
        }),
      );
    }
  }

  if (published.length === 0 && lastSkip !== undefined) return { skipped: lastSkip, published };
  return { published };
}

/** Persist what the engine decided about one participant. */
export async function applyToRepository(input: {
  readonly repository: JourneyRepository;
  readonly participantId: string;
  readonly effects: readonly JourneyEffect[];
  readonly restingStepId: string | null;
  readonly now: Date;
}): Promise<void> {
  const park = input.effects.find((effect) => effect.kind === "park");
  const exited = input.effects.find((effect) => effect.kind === "exit");

  if (exited !== undefined) {
    await input.repository.exit({
      id: input.participantId,
      reason: exited.reason,
      at: input.now,
    });
    return;
  }
  if (park !== undefined) {
    await input.repository.moveTo({
      id: input.participantId,
      step_id: park.step_id,
      wait_until: park.wait_until,
    });
    return;
  }
  if (input.restingStepId !== null) {
    await input.repository.moveTo({
      id: input.participantId,
      step_id: input.restingStepId,
      wait_until: null,
    });
  }
}

/** Shape an engine effect into the event this service publishes. */
export function toOutgoing(input: {
  readonly effect: Extract<JourneyEffect, { kind: "emit" }>;
  readonly event: Pick<IncomingEvent, "project_id" | "environment">;
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
