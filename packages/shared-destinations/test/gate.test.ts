/**
 * The routing gate.
 *
 * Two properties carry the most weight here and both are about SAFETY of
 * introduction rather than cleverness: an unconfigured project must behave
 * exactly as it did before the gate existed, and configuration must never be
 * able to relax a consent requirement the vendor declared in code.
 *
 * The rest pins the decision ORDER, because the order does not change which
 * events pass — all three checks must pass — but it decides the reason
 * recorded for those that do not, and that reason is the whole operational
 * value of a skipped row.
 */

import { describe, expect, it } from "vitest";

import { evaluateGate, type GateEnvelope, parseRoutingGateConfig } from "../src/gate.js";

function envelope(overrides: Partial<GateEnvelope> = {}): GateEnvelope {
  return {
    event: "payment.approved",
    properties: { plan: "pro", amount: 4200, trial: false },
    context: { locale: "en-GB" },
    profile: {
      profile_id: "01a00000-0000-7000-8000-00000000f001",
      traits: { tier: "gold", region: "emea" },
    },
    enrichment: { geo: { country: "GB", region: "ENG", city: "London", source: "maxmind" } },
    ...overrides,
  };
}

describe("gate: absent configuration", () => {
  it("passes everything when no config exists", () => {
    // The property that makes this safe to land before the vendor flips:
    // nothing changes until someone configures it.
    expect(evaluateGate({ envelope: envelope(), config: undefined, vendorConsent: {} })).toEqual({
      kind: "pass",
    });
  });

  it("passes everything when subscriptions are declared but empty", () => {
    // An empty list is "I have not decided", not "I want nothing". The
    // opposite reading would silently mute a destination the moment
    // someone created a config row.
    expect(
      evaluateGate({
        envelope: envelope(),
        config: { subscriptions: { events: [], prefixes: [] } },
        vendorConsent: {},
      }),
    ).toEqual({ kind: "pass" });
  });
});

describe("gate: subscriptions", () => {
  it("passes an exactly subscribed event", () => {
    const decision = evaluateGate({
      envelope: envelope(),
      config: { subscriptions: { events: ["payment.approved"] } },
      vendorConsent: {},
    });
    expect(decision.kind).toBe("pass");
  });

  it("passes on a namespace prefix", () => {
    const decision = evaluateGate({
      envelope: envelope(),
      config: { subscriptions: { prefixes: ["payment."] } },
      vendorConsent: {},
    });
    expect(decision.kind).toBe("pass");
  });

  it("skips an unsubscribed event and says which", () => {
    const decision = evaluateGate({
      envelope: envelope({ event: "page.viewed" }),
      config: { subscriptions: { events: ["payment.approved"] } },
      vendorConsent: {},
    });
    expect(decision).toEqual({
      kind: "skip",
      reason: "unsubscribed",
      detail: 'event "page.viewed" is not in this instance\'s subscriptions',
    });
  });
});

describe("gate: property filters", () => {
  it("filters on a producer property", () => {
    const pass = evaluateGate({
      envelope: envelope(),
      config: { filters: [{ path: "properties.plan", op: "equals", value: "pro" }] },
      vendorConsent: {},
    });
    expect(pass.kind).toBe("pass");

    const skip = evaluateGate({
      envelope: envelope(),
      config: { filters: [{ path: "properties.plan", op: "equals", value: "free" }] },
      vendorConsent: {},
    });
    expect(skip.kind).toBe("skip");
    expect(skip.kind === "skip" && skip.reason).toBe("filtered");
  });

  it("filters on a profile trait — the reason the gate runs pre-normalize", () => {
    // Normalize strips the envelope down to a vendor-shaped payload, so a
    // filter that wanted a trait would have nothing left to read if the
    // gate ran after it.
    const decision = evaluateGate({
      envelope: envelope(),
      config: { filters: [{ path: "profile.traits.tier", op: "in", value: ["gold", "platinum"] }] },
      vendorConsent: {},
    });
    expect(decision.kind).toBe("pass");
  });

  it("filters on platform enrichment", () => {
    const decision = evaluateGate({
      envelope: envelope(),
      config: { filters: [{ path: "enrichment.geo.country", op: "not_in", value: ["US"] }] },
      vendorConsent: {},
    });
    expect(decision.kind).toBe("pass");
  });

  it("requires every filter to match", () => {
    const decision = evaluateGate({
      envelope: envelope(),
      config: {
        filters: [
          { path: "properties.plan", op: "equals", value: "pro" },
          { path: "properties.amount", op: "equals", value: 1 },
        ],
      },
      vendorConsent: {},
    });
    expect(decision.kind).toBe("skip");
  });

  it("does not coerce types", () => {
    // `"4200"` is not `4200`. A coercing comparison would make a filter's
    // behaviour depend on how a producer serialised the value, which
    // surfaces months later as "this destination went quiet".
    const decision = evaluateGate({
      envelope: envelope(),
      config: { filters: [{ path: "properties.amount", op: "equals", value: "4200" }] },
      vendorConsent: {},
    });
    expect(decision.kind).toBe("skip");
  });

  it("distinguishes a false value from an absent one", () => {
    const present = evaluateGate({
      envelope: envelope(),
      config: { filters: [{ path: "properties.trial", op: "exists" }] },
      vendorConsent: {},
    });
    expect(present.kind).toBe("pass");

    const absent = evaluateGate({
      envelope: envelope(),
      config: { filters: [{ path: "properties.nope", op: "exists" }] },
      vendorConsent: {},
    });
    expect(absent.kind).toBe("skip");
  });

  it("never echoes the envelope value into the skip detail", () => {
    // A delivery record is widely readable and the value may be customer
    // data. The path and the operator are enough to debug a filter.
    const decision = evaluateGate({
      envelope: envelope({ properties: { email: "someone@example.com" } }),
      config: { filters: [{ path: "properties.email", op: "equals", value: "other@example.com" }] },
      vendorConsent: {},
    });
    expect(decision.kind).toBe("skip");
    expect(decision.kind === "skip" && decision.detail).not.toContain("example.com");
  });

  it("cannot be pointed at an unlisted root", () => {
    // `identity` is deliberately not filterable: routing on who someone IS
    // is both a privacy hazard and the wrong tool now that traits exist.
    // Refused when the config is READ, so such a filter can never reach a
    // running gate at all.
    expect(
      parseRoutingGateConfig({ filters: [{ path: "identity.customer_id", op: "exists" }] }),
    ).toBeUndefined();
  });
});

describe("gate: consent", () => {
  it("keeps absent-as-true", () => {
    // The existing platform semantic. Changing it here would start
    // dropping events for every project that never sent a consent block.
    const decision = evaluateGate({
      envelope: envelope({ consent: undefined }),
      config: { requireConsent: ["marketing"] },
      vendorConsent: {},
    });
    expect(decision.kind).toBe("pass");
  });

  it("skips when a required dimension is explicitly denied", () => {
    const decision = evaluateGate({
      envelope: envelope({ consent: { marketing: false } }),
      config: { requireConsent: ["marketing"] },
      vendorConsent: {},
    });
    expect(decision).toEqual({
      kind: "skip",
      reason: "consent",
      detail: 'consent dimension "marketing" not granted',
    });
  });

  it("cannot relax what the vendor declared in code", () => {
    // THE containment property. An instance may require MORE than its
    // vendor does; a config row that could require LESS would let a
    // database value undo a compliance decision made in versioned code.
    const decision = evaluateGate({
      envelope: envelope({ consent: { analytics: false } }),
      config: { requireConsent: ["marketing"] },
      vendorConsent: { analytics: true },
    });
    expect(decision.kind).toBe("skip");
    expect(decision.kind === "skip" && decision.reason).toBe("consent");
  });

  it("leaves vendor consent to normalize when the instance requires none", () => {
    // With no instance-level requirement the gate does not evaluate consent
    // at all — normalize still applies the vendor's own, exactly as before,
    // so this path is unchanged for every destination shipping today.
    const decision = evaluateGate({
      envelope: envelope({ consent: { analytics: false } }),
      config: {},
      vendorConsent: { analytics: true },
    });
    expect(decision.kind).toBe("pass");
  });
});

describe("parseRoutingGateConfig", () => {
  // The config arrives as an untyped jsonb bag, so this is the only place
  // that decides what an operator's typo does to a running destination.

  it("reads a complete config", () => {
    expect(
      parseRoutingGateConfig({
        subscriptions: { events: ["payment.approved"], prefixes: ["order."] },
        filters: [{ path: "properties.plan", op: "in", value: ["pro", "team"] }],
        requireConsent: ["marketing"],
      }),
    ).toEqual({
      subscriptions: { events: ["payment.approved"], prefixes: ["order."] },
      filters: [{ path: "properties.plan", op: "in", value: ["pro", "team"] }],
      requireConsent: ["marketing"],
    });
  });

  it("returns undefined for absent or non-object values", () => {
    expect(parseRoutingGateConfig(undefined)).toBeUndefined();
    expect(parseRoutingGateConfig(null)).toBeUndefined();
    expect(parseRoutingGateConfig("routing")).toBeUndefined();
    expect(parseRoutingGateConfig([])).toBeUndefined();
  });

  it("rejects the whole config rather than applying half of it", () => {
    // An operator writes the routing block as one unit. Silently keeping the
    // valid half would be the more surprising outcome — the destination would
    // be running a config nobody wrote.
    expect(
      parseRoutingGateConfig({
        subscriptions: { events: ["payment.approved"] },
        filters: "not a list",
      }),
    ).toBeUndefined();
  });

  it("refuses a filter on a root that is not addressable", () => {
    // Caught here rather than resolving to `undefined` at evaluation time: a
    // filter on `identity.email` that quietly never matched would read to its
    // author as a working rule, and would be a privacy hazard if it worked.
    expect(
      parseRoutingGateConfig({
        filters: [{ path: "identity.email", op: "exists" }],
      }),
    ).toBeUndefined();
  });

  it("refuses an unknown operator and an unknown consent dimension", () => {
    expect(
      parseRoutingGateConfig({ filters: [{ path: "properties.a", op: "matches", value: "x" }] }),
    ).toBeUndefined();
    expect(parseRoutingGateConfig({ requireConsent: ["telepathy"] })).toBeUndefined();
  });

  it("accepts exists/not_exists without a value, and requires one otherwise", () => {
    expect(parseRoutingGateConfig({ filters: [{ path: "properties.a", op: "exists" }] })).toEqual({
      filters: [{ path: "properties.a", op: "exists" }],
    });
    expect(
      parseRoutingGateConfig({ filters: [{ path: "properties.a", op: "equals" }] }),
    ).toBeUndefined();
  });

  it("refuses a non-scalar filter value", () => {
    // Comparison is strict `===`, so an object value could never match
    // anything. Accepting it would store a rule guaranteed to be inert.
    expect(
      parseRoutingGateConfig({
        filters: [{ path: "properties.a", op: "equals", value: { b: 1 } }],
      }),
    ).toBeUndefined();
  });
});

describe("gate: decision order", () => {
  it("reports the subscription miss when an event fails several checks", () => {
    // Order does not change WHICH events pass — all three must pass — but
    // it decides the reason recorded, and "not subscribed" is the fact an
    // operator can act on.
    const decision = evaluateGate({
      envelope: envelope({ event: "page.viewed", consent: { marketing: false } }),
      config: {
        subscriptions: { events: ["payment.approved"] },
        filters: [{ path: "properties.plan", op: "equals", value: "free" }],
        requireConsent: ["marketing"],
      },
      vendorConsent: {},
    });
    expect(decision.kind === "skip" && decision.reason).toBe("unsubscribed");
  });

  it("reports the filter miss before the consent miss", () => {
    const decision = evaluateGate({
      envelope: envelope({ consent: { marketing: false } }),
      config: {
        subscriptions: { events: ["payment.approved"] },
        filters: [{ path: "properties.plan", op: "equals", value: "free" }],
        requireConsent: ["marketing"],
      },
      vendorConsent: {},
    });
    expect(decision.kind === "skip" && decision.reason).toBe("filtered");
  });
});
