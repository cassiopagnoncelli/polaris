/**
 * Audience transitions reaching Braze, through the real chain.
 *
 * The other mapper tests hand a hand-built `NormalizedEvent` straight to
 * a mapper, which is right for asserting payload shape and wrong for
 * this: the question here is whether a transition SURVIVES the path from
 * `profile.events` to a Braze attribute, and every way it can fail lives
 * in the steps the fixture skips.
 *
 * It failed in exactly that gap before this card. The emitter set
 * `identity: {}` — correctly, a computed fact belongs to a profile, not
 * to an identifier the run never saw — and `normalizeForDestination`
 * dropped every transition at `no_usable_identity` before any mapper ran.
 * A mapper test using a fixture with a populated identity would have
 * passed the whole time.
 *
 * So this runs the actual normalizer on an actual transition envelope.
 */

import { type NormalizableEnvelope, normalizeForDestination } from "@polaris/delivery-normalize";
import { describe, expect, it } from "vitest";

import { createBrazeDescriptor } from "../src/connector.js";
import { audienceEnteredMapper, audienceExitedMapper } from "../src/mapper.js";
import type { BrazePayload } from "../src/types.js";
import { fixtureDestinationInstance } from "./fixtures/normalized.js";

const PROFILE_ID = "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551";

/** What the audiences emitter actually publishes onto `profile.events`. */
function transitionEnvelope(
  event: "audience.entered" | "audience.exited",
  overrides: {
    canonicalCustomerId?: string | null;
    audience?: unknown;
  } = {},
): NormalizableEnvelope {
  const at = "2026-08-17T03:00:00.000Z";
  return {
    event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f5aa",
    event,
    schema_version: 1,
    project_id: "storefront",
    environment: "production",
    occurred_at: at,
    ingested_at: at,
    source: { id: "audiences-v1", type: "internal" },
    // Empty, as the emitter leaves it.
    identity: {},
    context: {},
    profile: {
      profile_id: PROFILE_ID,
      canonical_customer_id:
        overrides.canonicalCustomerId === undefined ? "cus_9142" : overrides.canonicalCustomerId,
    },
    properties: {
      audience: overrides.audience === undefined ? "high_value" : overrides.audience,
      audience_version: 3,
      profile_id: PROFILE_ID,
      run_id: "polaris_arun_1",
      ...(event === "audience.entered"
        ? { re_entry: false }
        : { entered_at: "2026-07-01T00:00:00.000Z" }),
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

describe("a transition survives normalize", () => {
  it("keeps an entered transition, keyed on the profile block's customer id", () => {
    // The load-bearing assertion. `identity: {}` plus a populated profile
    // block is the emitter's exact output, and this is the step that used
    // to drop it.
    const outcome = normalize(transitionEnvelope("audience.entered"));

    expect(outcome.kind).toBe("normalized");
    if (outcome.kind !== "normalized") return;
    expect(outcome.normalized.identity.canonical_customer_id).toBe("cus_9142");
    expect(outcome.normalized.identity.profile_id).toBe(PROFILE_ID);
  });

  it("keeps a transition for a profile with no customer id, on profile_id alone", () => {
    // Normalize keeps it — `pickBestIdentity` ranks `profile_id` second —
    // and the DESTINATION is what declines it below. The two decisions
    // are separate on purpose: the platform has a usable identity, the
    // vendor does not have one it can key on.
    const outcome = normalize(
      transitionEnvelope("audience.entered", { canonicalCustomerId: null }),
    );

    expect(outcome.kind).toBe("normalized");
  });
});

describe("the Braze mappers", () => {
  function mapped(event: "audience.entered" | "audience.exited", overrides = {}) {
    const outcome = normalize(transitionEnvelope(event, overrides));
    if (outcome.kind !== "normalized") throw new Error(`normalize dropped: ${outcome.reason}`);
    const mapper = event === "audience.entered" ? audienceEnteredMapper : audienceExitedMapper;
    return mapper({
      normalized: outcome.normalized,
      instance: fixtureDestinationInstance(),
    } as never);
  }

  it("writes a true attribute on entry, namespaced by audience", () => {
    const result = mapped("audience.entered");

    expect(result.kind).toBe("mapped");
    if (result.kind !== "mapped") return;
    const attributes = (result.payload as BrazePayload).attributes;
    expect(attributes?.[0]).toMatchObject({
      external_id: "cus_9142",
      polaris_audience_high_value: true,
      // Never creates a Braze user from a membership change: a profile
      // carrying nothing but an audience flag is one the brand cannot
      // message, and it bills against their MAU.
      _update_existing_only: true,
    });
  });

  it("writes false on exit rather than deleting the attribute", () => {
    // An absent attribute is indistinguishable from "this user predates
    // the audience", so a campaign targeting non-members would silently
    // include everyone the platform never evaluated.
    const result = mapped("audience.exited");

    expect(result.kind).toBe("mapped");
    if (result.kind !== "mapped") return;
    const attributes = (result.payload as BrazePayload).attributes;
    expect(attributes?.[0]).toMatchObject({ polaris_audience_high_value: false });
  });

  it("namespaces the attribute, so an audience cannot collide with a trait", () => {
    // `tier` is a plausible audience key AND a trait this vendor already
    // writes as a bare attribute.
    const result = mapped("audience.entered", { audience: "tier" });

    expect(result.kind).toBe("mapped");
    if (result.kind !== "mapped") return;
    const attribute = (result.payload as BrazePayload).attributes?.[0] as Record<string, unknown>;
    expect(attribute["polaris_audience_tier"]).toBe(true);
    expect(attribute["tier"]).toBeUndefined();
  });

  it("skips a profile with no customer id instead of keying on the internal id", () => {
    // Braze's `external_id` must be an id the brand's own systems know.
    // Sending Polaris's profile UUID would create a user nobody can
    // reconcile.
    const outcome = normalize(
      transitionEnvelope("audience.entered", { canonicalCustomerId: null }),
    );
    if (outcome.kind !== "normalized") throw new Error("normalize dropped");

    const result = audienceEnteredMapper({
      normalized: outcome.normalized,
      instance: fixtureDestinationInstance(),
    } as never);

    expect(result.kind).toBe("skip");
    if (result.kind !== "skip") return;
    expect(result.reason).toBe("no_identifier_for_braze_attribute");
  });

  it("skips rather than writing a junk attribute when the audience is missing", () => {
    const result = mapped("audience.entered", { audience: 42 });

    expect(result.kind).toBe("skip");
    if (result.kind !== "skip") return;
    expect(result.reason).toBe("audience_missing_from_properties");
  });

  it("dedupes on the event id, which the emitter derives per (run, audience, profile)", () => {
    const result = mapped("audience.entered");
    expect(result.kind).toBe("mapped");
    if (result.kind !== "mapped") return;
    expect(result.dedupe_key).toBe("018f1b9e-7b50-7b12-9a2e-0e2f88d8f5aa");
  });
});

describe("the descriptor", () => {
  it("registers both transition events, so the runtime can reach the mappers", () => {
    // A mapper the descriptor does not list is a mapper the runtime never
    // calls — it would report `skipped_unmapped` and look like a routing
    // decision rather than a missing registration.
    const descriptor = createBrazeDescriptor({ fetch: globalThis.fetch, requestTimeoutMs: 5_000 });
    expect(Object.keys(descriptor.mappers)).toContain("audience.entered");
    expect(Object.keys(descriptor.mappers)).toContain("audience.exited");
  });
});
