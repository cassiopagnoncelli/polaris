/**
 * A journey action reaching Braze, through the real chain.
 *
 * §6.1 of the redesign says a journey action reaches "any vendor". The
 * path was real and demonstrated end to end — but only through
 * `webhook-sink`, whose mapper is a passthrough that accepts anything. A
 * promise that holds for a receiver which maps nothing and for no vendor
 * which maps something is not the promise that was made.
 *
 * Run through `normalizeForDestination` rather than against a hand-built
 * `NormalizedEvent`, for the reason the audience-transitions suite exists:
 * the orchestrator publishes `identity: {}` on purpose — a journey event
 * belongs to a PROFILE, and inventing an identifier would claim the run
 * saw one it never touched — and normalize is exactly the step that
 * dropped audience transitions on that shape. A mapper test starting from
 * a populated identity would pass while nothing reached the vendor.
 */

import { type NormalizableEnvelope, normalizeForDestination } from "@polaris/delivery-normalize";
import { describe, expect, it } from "vitest";

import { createBrazeDescriptor } from "../src/connector.js";
import {
  BRAZE_EVENT_JOURNEY_STEP,
  journeyEnteredMapper,
  journeyExitedMapper,
  journeyStepAdvancedMapper,
} from "../src/mapper.js";
import type { BrazePayload } from "../src/types.js";
import { fixtureDestinationInstance } from "./fixtures/normalized.js";

const PROFILE_ID = "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551";

type JourneyEvent = "journey.entered" | "journey.step_advanced" | "journey.exited";

/** What the orchestrator actually publishes onto `profile.events`. */
function journeyEnvelope(
  event: JourneyEvent,
  overrides: {
    canonicalCustomerId?: string | null;
    properties?: Record<string, unknown>;
    actionProperties?: unknown;
  } = {},
): NormalizableEnvelope {
  const at = "2026-08-19T03:00:00.000Z";
  return {
    event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f5bb",
    event,
    schema_version: 1,
    project_id: "storefront",
    environment: "production",
    occurred_at: at,
    ingested_at: at,
    source: { id: "journey-orchestrator-v1", type: "internal" },
    // Empty, as the orchestrator leaves it. See the module header.
    identity: {},
    context: {},
    profile: {
      profile_id: PROFILE_ID,
      canonical_customer_id:
        overrides.canonicalCustomerId === undefined ? "cus_9142" : overrides.canonicalCustomerId,
    },
    properties: {
      journey: "welcome_recent_purchasers",
      journey_version: 1,
      profile_id: PROFILE_ID,
      step_id: "thank_repeat",
      run_id: "polaris_jrun_1",
      ...(event === "journey.step_advanced"
        ? {
            from_step_id: "is_repeat_customer",
            properties:
              overrides.actionProperties === undefined
                ? { message: "thank_you_repeat" }
                : overrides.actionProperties,
          }
        : {}),
      ...(event === "journey.entered" ? { trigger: "payment.approved", re_entry: false } : {}),
      ...(event === "journey.exited" ? { reason: "completed" } : {}),
      ...overrides.properties,
    },
  } as unknown as NormalizableEnvelope;
}

function normalize(envelope: NormalizableEnvelope) {
  const descriptor = createBrazeDescriptor({ fetch: globalThis.fetch, requestTimeoutMs: 5_000 });
  return normalizeForDestination(envelope, {
    destinationId: fixtureDestinationInstance().destination_id,
    requiredConsent: descriptor.requiredConsent,
    ...(descriptor.identityHashing !== undefined
      ? { identityHashing: descriptor.identityHashing }
      : {}),
    ...(descriptor.identityFromProperties !== undefined
      ? { identityFromProperties: descriptor.identityFromProperties }
      : {}),
  });
}

const MAPPERS = {
  "journey.entered": journeyEnteredMapper,
  "journey.step_advanced": journeyStepAdvancedMapper,
  "journey.exited": journeyExitedMapper,
} as const;

function mapped(event: JourneyEvent, overrides = {}) {
  const outcome = normalize(journeyEnvelope(event, overrides));
  if (outcome.kind !== "normalized") throw new Error(`normalize dropped: ${outcome.reason}`);
  return MAPPERS[event]({
    normalized: outcome.normalized,
    instance: fixtureDestinationInstance(),
  } as never);
}

describe("a journey event survives normalize", () => {
  it("keeps it, keyed on the profile block's customer id", () => {
    // The load-bearing step. `identity: {}` plus a populated profile block
    // is the orchestrator's exact output, and this is where the audience
    // plane used to lose everything.
    const outcome = normalize(journeyEnvelope("journey.step_advanced"));

    expect(outcome.kind).toBe("normalized");
    if (outcome.kind !== "normalized") return;
    expect(outcome.normalized.identity.canonical_customer_id).toBe("cus_9142");
    expect(outcome.normalized.identity.profile_id).toBe(PROFILE_ID);
  });
});

describe("journey.step_advanced — the action", () => {
  it("becomes one custom event carrying the journey coordinates", () => {
    const result = mapped("journey.step_advanced");

    expect(result.kind).toBe("mapped");
    if (result.kind !== "mapped") return;
    const events = (result.payload as BrazePayload).events;
    expect(events).toHaveLength(1);
    expect(events?.[0]).toMatchObject({
      external_id: "cus_9142",
      name: BRAZE_EVENT_JOURNEY_STEP,
      time: "2026-08-19T03:00:00.000Z",
    });
  });

  it("uses ONE event name for every journey and step", () => {
    // Braze custom-event names are a bounded, billed dimension in the
    // customer's account. A name minted per (journey, step) would let a
    // change in the Polaris catalog consume their namespace; a campaign
    // filters on the properties instead.
    const a = mapped("journey.step_advanced");
    const b = mapped("journey.step_advanced", {
      properties: { journey: "win_back", step_id: "offer" },
    });
    if (a.kind !== "mapped" || b.kind !== "mapped") throw new Error("expected both to map");
    const nameOf = (r: typeof a) => (r.payload as BrazePayload).events?.[0]?.name;
    expect(nameOf(a)).toBe(BRAZE_EVENT_JOURNEY_STEP);
    expect(nameOf(b)).toBe(BRAZE_EVENT_JOURNEY_STEP);
  });

  it("carries the action's own payload through", () => {
    // The point of §6.1. Without this the vendor learns that a step
    // happened and nothing about what the author wanted sent.
    const result = mapped("journey.step_advanced");
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect((result.payload as BrazePayload).events?.[0]?.properties).toMatchObject({
      message: "thank_you_repeat",
      journey: "welcome_recent_purchasers",
      step_id: "thank_repeat",
      journey_version: 1,
    });
  });

  it("does not let an action payload overwrite the journey coordinates", () => {
    // The payload is author-defined and `journey` is a plausible key in
    // it. A campaign filtering on `journey = welcome_recent_purchasers`
    // must not be steerable from a journey definition.
    const result = mapped("journey.step_advanced", {
      actionProperties: { journey: "attacker_choice", step_id: "elsewhere", message: "hi" },
    });
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect((result.payload as BrazePayload).events?.[0]?.properties).toMatchObject({
      journey: "welcome_recent_purchasers",
      step_id: "thank_repeat",
      message: "hi",
    });
  });

  it("drops non-primitive payload values rather than letting Braze reject the batch", () => {
    const result = mapped("journey.step_advanced", {
      actionProperties: { ok: "yes", n: 2, flag: true, nested: { a: 1 }, list: [1, 2] },
    });
    if (result.kind !== "mapped") throw new Error("expected mapped");
    const properties = (result.payload as BrazePayload).events?.[0]?.properties as Record<
      string,
      unknown
    >;
    expect(properties["ok"]).toBe("yes");
    expect(properties["n"]).toBe(2);
    expect(properties["flag"]).toBe(true);
    expect(properties["nested"]).toBeUndefined();
    expect(properties["list"]).toBeUndefined();
  });

  it("skips a profile Braze cannot key on, rather than posting a 400", () => {
    const result = mapped("journey.step_advanced", { canonicalCustomerId: null });
    expect(result.kind).toBe("skip");
  });
});

describe("journey.entered / journey.exited — the membership", () => {
  it("writes a true attribute on entry, namespaced away from audiences", () => {
    // `vip` is a plausible name for both an audience and a journey, and
    // one silently overwriting the other would make a suppression rule
    // follow the wrong thing.
    const result = mapped("journey.entered");
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect((result.payload as BrazePayload).attributes?.[0]).toMatchObject({
      external_id: "cus_9142",
      polaris_journey_welcome_recent_purchasers: true,
      // Entering a journey is not a first-touch identification.
      _update_existing_only: true,
    });
  });

  it("writes false on exit rather than deleting the attribute", () => {
    // An absent attribute is indistinguishable from "predates the
    // journey", so a suppression rule written against non-members would
    // quietly include everyone Polaris has never evaluated.
    const result = mapped("journey.exited");
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect((result.payload as BrazePayload).attributes?.[0]).toMatchObject({
      polaris_journey_welcome_recent_purchasers: false,
      _update_existing_only: true,
    });
  });
});

describe("the descriptor", () => {
  it("registers all three, so the runtime does not record them as unmapped", () => {
    // A mapper nothing routes to is dead code, and the runtime's
    // "no mapper registered" outcome is what an operator would have seen.
    const descriptor = createBrazeDescriptor({
      fetch: globalThis.fetch,
      requestTimeoutMs: 5_000,
    });
    for (const event of Object.keys(MAPPERS)) {
      expect(descriptor.mappers[event], `${event} has no mapper`).toBeDefined();
    }
  });
});
