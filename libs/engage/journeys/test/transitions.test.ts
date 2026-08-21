/**
 * The two edges of a participation.
 *
 * Both used to be reachable only through the orchestrator's message loop,
 * which meant a question about the shape of a published property needed a
 * repository double and a profile reader to ask.
 */

import { welcomeRecentPurchasers } from "@polaris/journey-catalog";
import { describe, expect, it } from "vitest";

import { toOutgoing, triggerLabel, triggerMatches } from "../src/index.js";

const SCOPE = { project_id: "storefront", environment: "production" } as const;

describe("triggerMatches", () => {
  it("matches an audience trigger only for its own audience", () => {
    expect(
      triggerMatches(welcomeRecentPurchasers, {
        event: "audience.entered",
        properties: { audience: "recent_purchasers" },
      }),
    ).toBe(true);
    expect(
      triggerMatches(welcomeRecentPurchasers, {
        event: "audience.entered",
        properties: { audience: "other" },
      }),
    ).toBe(false);
    expect(triggerMatches(welcomeRecentPurchasers, { event: "payment.approved" })).toBe(false);
  });

  it("refuses an audience.entered carrying no audience at all", () => {
    // A malformed or replayed envelope. Admitting on the event NAME alone
    // would enter every profile the audience runner ever announced into a
    // journey scoped to one population.
    expect(triggerMatches(welcomeRecentPurchasers, { event: "audience.entered" })).toBe(false);
  });

  it("matches an event trigger on the name, leaving `where` to the caller", () => {
    const onPayment = {
      ...welcomeRecentPurchasers,
      trigger: { type: "event" as const, event: "payment.approved" },
    };
    expect(triggerMatches(onPayment, { event: "payment.approved" })).toBe(true);
    expect(triggerMatches(onPayment, { event: "audience.entered" })).toBe(false);
  });
});

describe("triggerLabel", () => {
  it("names the audience for an audience trigger and the event for an event one", () => {
    expect(triggerLabel(welcomeRecentPurchasers)).toBe("recent_purchasers");
    expect(
      triggerLabel({
        ...welcomeRecentPurchasers,
        trigger: { type: "event", event: "payment.approved" },
      }),
    ).toBe("payment.approved");
  });
});

describe("toOutgoing", () => {
  const base = {
    event: SCOPE,
    definition: welcomeRecentPurchasers,
    profileId: "019ffe00-0000-7000-8000-00000000f001",
    run_id: "polaris_jrun_1",
    triggerLabel: "recent_purchasers",
    reEntry: false,
  };

  it("stamps an entry with what admitted it and whether they had been through", () => {
    const outgoing = toOutgoing({
      ...base,
      reEntry: true,
      effect: { kind: "emit", event: "journey.entered", step_id: "settle" },
    });
    expect(outgoing).toEqual({
      event: "journey.entered",
      project_id: "storefront",
      environment: "production",
      profile_id: base.profileId,
      properties: {
        journey: "welcome_recent_purchasers",
        journey_version: 1,
        profile_id: base.profileId,
        step_id: "settle",
        run_id: "polaris_jrun_1",
        trigger: "recent_purchasers",
        re_entry: true,
      },
    });
  });

  it("defaults an exit with no stated reason to completed", () => {
    // Every exit is answerable months later, so the property is always
    // present; an exit that arrived without one completed the graph.
    const outgoing = toOutgoing({
      ...base,
      effect: { kind: "emit", event: "journey.exited", step_id: "done" },
    });
    expect(outgoing.properties["reason"]).toBe("completed");
  });

  it("carries a step's own properties and where it came from", () => {
    const outgoing = toOutgoing({
      ...base,
      effect: {
        kind: "emit",
        event: "journey.step_advanced",
        step_id: "thank_first",
        from_step_id: "is_repeat_customer",
        properties: { message: "thank_you_first" },
      },
    });
    expect(outgoing.properties).toMatchObject({
      from_step_id: "is_repeat_customer",
      properties: { message: "thank_you_first" },
    });
  });

  it("omits the optional properties rather than sending them as undefined", () => {
    // A destination mapping reads `Object.hasOwn`; a key present and
    // undefined is not the same as a key that was never set.
    const outgoing = toOutgoing({
      ...base,
      effect: { kind: "emit", event: "journey.step_advanced", step_id: "thank_first" },
    });
    expect(Object.hasOwn(outgoing.properties, "from_step_id")).toBe(false);
    expect(Object.hasOwn(outgoing.properties, "properties")).toBe(false);
  });
});
