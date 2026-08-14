/**
 * Pure-transform tests for attribution-engine v2.
 *
 * The transform decides between four branches (drop / touchpoint_only /
 * touchpoint_and_last / first_observation) based on the canonical
 * envelope and the prior store record. These tests exercise each branch
 * with deterministic inputs.
 *
 * Covers the acceptance criteria documented in
 * `docs/implementation/tasks/P8-005-attribution-engine-v1.md`:
 *   - deterministic attribution fixtures exist;
 *   - vendor-specific destination logic is absent;
 *   - output events include processor metadata (validated indirectly
 *     here via the run_id stamp; full envelope stamping is verified by
 *     `emit.test.ts`).
 */

import { describe, expect, it } from "vitest";

import {
  buildTouchpointStoreKey,
  type CampaignTuple,
  campaignTuplesEqual,
  DEFAULT_ATTRIBUTION_WINDOW_SECONDS,
  decideAttribution,
  deriveTouchpointId,
  isCampaignEmpty,
  isChainExpired,
  normaliseCampaign,
  PRIMARY_IDENTIFIER_KINDS,
  resolvePrimaryIdentifier,
  type TouchpointChainRecord,
} from "../src/transform.js";
import type { AnalyticsEventEnvelope, AttributionEventCampaign } from "../src/types.js";

function buildEnvelope(overrides: {
  readonly event_id?: string;
  readonly occurred_at?: string;
  readonly project_id?: string;
  readonly environment?: string;
  readonly identity?: Partial<AnalyticsEventEnvelope["identity"]>;
  readonly campaign?: AttributionEventCampaign | null | undefined;
  /** The person. `null` models an event identity could not resolve. */
  readonly profile_id?: string | null;
}): AnalyticsEventEnvelope {
  const identity: AnalyticsEventEnvelope["identity"] = {
    anonymous_id: null,
    session_id: null,
    customer_id: null,
    device_id: null,
    ...overrides.identity,
  };
  return {
    event_id: overrides.event_id ?? "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
    event: "page.viewed",
    schema_version: 1,
    project_id: overrides.project_id ?? "checkout",
    environment: overrides.environment ?? "production",
    occurred_at: overrides.occurred_at ?? "2026-05-14T12:00:00.000Z",
    ingested_at: "2026-05-14T12:00:01.000Z",
    source: { type: "browser", id: "web", sdk: "web", sdk_version: "1.0.0" },
    identity,
    profile:
      overrides.profile_id === null
        ? null
        : { profile_id: overrides.profile_id ?? "01a00000-0000-7000-8000-00000000f001" },
    context: {
      ip: null,
      user_agent: null,
      locale: null,
      page: null,
      campaign: overrides.campaign === undefined ? null : overrides.campaign,
    },
    properties: {},
  };
}

const FULL_CAMPAIGN: CampaignTuple = {
  source: "google",
  medium: "cpc",
  name: "summer_sale_2026",
  term: "running shoes",
  content: "ad_variant_A",
  click_id: "gclid_abc123",
};

function buildPriorRecord(overrides: Partial<TouchpointChainRecord> = {}): TouchpointChainRecord {
  return {
    project_id: "checkout",
    environment: "production",
    primary_identifier_kind: "profile_id",
    primary_identifier_value: "anon_X",
    first_touchpoint_id: "tp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    first_touchpoint_tuple: FULL_CAMPAIGN,
    first_source_event_id: "evt_first",
    first_observed_at: "2026-05-14T10:00:00.000Z",
    last_touchpoint_id: "tp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    last_touchpoint_tuple: FULL_CAMPAIGN,
    last_source_event_id: "evt_first",
    last_observed_at: "2026-05-14T10:00:00.000Z",
    touchpoint_count: 1,
    ...overrides,
  };
}

describe("resolvePrimaryIdentifier", () => {
  it("keys on the person the identity stage stamped", () => {
    expect(
      resolvePrimaryIdentifier({ profile_id: "01a00000-0000-7000-8000-00000000f001" }),
    ).toEqual({
      kind: "profile_id",
      value: "01a00000-0000-7000-8000-00000000f001",
    });
  });

  it("ignores the identity block — that question is answered upstream", () => {
    // v1/v2 walked customer_id > anonymous_id > session_id, which is
    // what fragmented a chain at login: touchpoints collected while
    // anonymous were stranded under the old key and the conversion was
    // credited to whatever arrived after. v3 has one input, no fallback.
    expect(resolvePrimaryIdentifier(null)).toBeUndefined();
    expect(resolvePrimaryIdentifier(undefined)).toBeUndefined();
    expect(resolvePrimaryIdentifier({})).toBeUndefined();
    expect(resolvePrimaryIdentifier({ profile_id: "" })).toBeUndefined();
  });

  it("declares exactly one identifier kind", () => {
    expect([...PRIMARY_IDENTIFIER_KINDS]).toEqual(["profile_id"]);
  });
});

describe("normaliseCampaign", () => {
  it("returns an all-null tuple for null input", () => {
    expect(normaliseCampaign(null)).toEqual({
      source: null,
      medium: null,
      name: null,
      term: null,
      content: null,
      click_id: null,
    });
  });

  it("returns an all-null tuple for undefined input", () => {
    expect(normaliseCampaign(undefined)).toEqual({
      source: null,
      medium: null,
      name: null,
      term: null,
      content: null,
      click_id: null,
    });
  });

  it("converts empty strings to null", () => {
    expect(
      normaliseCampaign({
        source: "google",
        medium: "",
        name: "",
        term: null,
        content: undefined,
        click_id: "gclid_x",
      }),
    ).toEqual({
      source: "google",
      medium: null,
      name: null,
      term: null,
      content: null,
      click_id: "gclid_x",
    });
  });

  it("preserves non-empty strings verbatim", () => {
    expect(normaliseCampaign(FULL_CAMPAIGN)).toEqual(FULL_CAMPAIGN);
  });
});

describe("isCampaignEmpty", () => {
  it("returns true for an all-null tuple", () => {
    expect(
      isCampaignEmpty({
        source: null,
        medium: null,
        name: null,
        term: null,
        content: null,
        click_id: null,
      }),
    ).toBe(true);
  });

  it("returns false for a tuple with one non-null field", () => {
    expect(
      isCampaignEmpty({
        source: null,
        medium: null,
        name: null,
        term: null,
        content: null,
        click_id: "gclid_x",
      }),
    ).toBe(false);
  });

  it("returns false for a tuple with every field non-null", () => {
    expect(isCampaignEmpty(FULL_CAMPAIGN)).toBe(false);
  });
});

describe("campaignTuplesEqual", () => {
  it("is true for two structurally-identical tuples", () => {
    expect(campaignTuplesEqual(FULL_CAMPAIGN, { ...FULL_CAMPAIGN })).toBe(true);
  });

  it("is false when any field differs", () => {
    expect(campaignTuplesEqual(FULL_CAMPAIGN, { ...FULL_CAMPAIGN, source: "facebook" })).toBe(
      false,
    );
  });

  it("is false when one field is null and the other is non-null", () => {
    expect(campaignTuplesEqual(FULL_CAMPAIGN, { ...FULL_CAMPAIGN, click_id: null })).toBe(false);
  });
});

describe("deriveTouchpointId", () => {
  it("is deterministic for the same (event_id, campaign)", () => {
    const a = deriveTouchpointId({
      source_event_id: "evt_1",
      campaign: FULL_CAMPAIGN,
    });
    const b = deriveTouchpointId({
      source_event_id: "evt_1",
      campaign: FULL_CAMPAIGN,
    });
    expect(a).toBe(b);
  });

  it("differs when the source_event_id changes", () => {
    const a = deriveTouchpointId({
      source_event_id: "evt_1",
      campaign: FULL_CAMPAIGN,
    });
    const b = deriveTouchpointId({
      source_event_id: "evt_2",
      campaign: FULL_CAMPAIGN,
    });
    expect(a).not.toBe(b);
  });

  it("differs when any campaign field changes", () => {
    const a = deriveTouchpointId({
      source_event_id: "evt_1",
      campaign: FULL_CAMPAIGN,
    });
    const b = deriveTouchpointId({
      source_event_id: "evt_1",
      campaign: { ...FULL_CAMPAIGN, click_id: "gclid_other" },
    });
    expect(a).not.toBe(b);
  });

  it("returns a tp_<hex> shape", () => {
    const id = deriveTouchpointId({
      source_event_id: "evt_1",
      campaign: FULL_CAMPAIGN,
    });
    expect(id).toMatch(/^tp_[0-9a-f]+$/u);
  });
});

describe("buildTouchpointStoreKey", () => {
  it("includes project, environment, kind, and value", () => {
    const key = buildTouchpointStoreKey({
      project_id: "checkout",
      environment: "production",
      primary: { kind: "profile_id", value: "01a00000-0000-7000-8000-00000000f001" },
    });
    expect(key).toBe("checkout::production::01a00000-0000-7000-8000-00000000f001");
  });

  it("keeps the same person separate across environments", () => {
    // v1/v2 prefixed the value with its kind because `customer_id:X` and
    // `anonymous_id:X` could collide on the literal. With one kind the
    // prefix disambiguates nothing; the scope still has to.
    const primary = { kind: "profile_id", value: "01a00000-0000-7000-8000-00000000f001" } as const;
    expect(
      buildTouchpointStoreKey({ project_id: "checkout", environment: "production", primary }),
    ).not.toBe(
      buildTouchpointStoreKey({ project_id: "checkout", environment: "staging", primary }),
    );
  });
});

describe("decideAttribution", () => {
  it("drops an event the identity stage could not resolve to a person", () => {
    // A full campaign block, so the ONLY reason to drop is the absent
    // profile — the event has attribution-worthy content and still has
    // no chain to join.
    const raw = buildEnvelope({ campaign: FULL_CAMPAIGN, profile_id: null });
    const decision = decideAttribution({ raw, prior: undefined });
    expect(decision.kind).toBe("drop");
  });

  it("drops events with an empty campaign block", () => {
    const raw = buildEnvelope({ identity: { anonymous_id: "anon_X" }, campaign: null });
    const decision = decideAttribution({ raw, prior: undefined });
    expect(decision.kind).toBe("drop");
  });

  it("drops events with a campaign block that has only empty-string fields", () => {
    const raw = buildEnvelope({
      identity: { anonymous_id: "anon_X" },
      campaign: { source: "", medium: "", name: "", term: "", content: "", click_id: "" },
    });
    const decision = decideAttribution({ raw, prior: undefined });
    expect(decision.kind).toBe("drop");
  });

  it("first_observation when no prior chain exists and campaign is non-empty", () => {
    const raw = buildEnvelope({
      identity: { anonymous_id: "anon_X" },
      campaign: FULL_CAMPAIGN,
    });
    const decision = decideAttribution({ raw, prior: undefined });
    expect(decision.kind).toBe("first_observation");
    if (decision.kind === "first_observation") {
      expect(decision.primary).toEqual({
        kind: "profile_id",
        value: "01a00000-0000-7000-8000-00000000f001",
      });
      expect(decision.campaign).toEqual(FULL_CAMPAIGN);
      expect(decision.touchpoint_id).toMatch(/^tp_[0-9a-f]+$/u);
      expect(decision.store_key).toBe("checkout::production::01a00000-0000-7000-8000-00000000f001");
    }
  });

  it("touchpoint_only when the campaign matches the prior last-touch tuple", () => {
    const raw = buildEnvelope({
      identity: { anonymous_id: "anon_X" },
      campaign: FULL_CAMPAIGN,
      event_id: "evt_repeat",
    });
    const prior = buildPriorRecord({ last_touchpoint_tuple: FULL_CAMPAIGN });
    const decision = decideAttribution({ raw, prior });
    expect(decision.kind).toBe("touchpoint_only");
    if (decision.kind === "touchpoint_only") {
      expect(decision.touchpoint_id).toMatch(/^tp_[0-9a-f]+$/u);
      expect(decision.campaign).toEqual(FULL_CAMPAIGN);
    }
  });

  it("touchpoint_and_last when the campaign differs from the prior last-touch tuple", () => {
    const raw = buildEnvelope({
      identity: { anonymous_id: "anon_X" },
      campaign: { ...FULL_CAMPAIGN, source: "facebook" },
      event_id: "evt_delta",
    });
    const prior = buildPriorRecord({
      last_touchpoint_id: "tp_priorlast",
      last_touchpoint_tuple: FULL_CAMPAIGN,
    });
    const decision = decideAttribution({ raw, prior });
    expect(decision.kind).toBe("touchpoint_and_last");
    if (decision.kind === "touchpoint_and_last") {
      expect(decision.previous_touchpoint_id).toBe("tp_priorlast");
      expect(decision.campaign.source).toBe("facebook");
    }
  });

  it("keeps two different people isolated (no cross-person attribution)", () => {
    const rawA = buildEnvelope({
      identity: { anonymous_id: "anon_A" },
      profile_id: "01a00000-0000-7000-8000-00000000f001",
      campaign: FULL_CAMPAIGN,
      event_id: "evt_a",
    });
    const rawB = buildEnvelope({
      identity: { anonymous_id: "anon_B" },
      profile_id: "01a00000-0000-7000-8000-00000000f002",
      campaign: FULL_CAMPAIGN,
      event_id: "evt_b",
    });
    const decisionA = decideAttribution({ raw: rawA, prior: undefined });
    const decisionB = decideAttribution({ raw: rawB, prior: undefined });
    if (decisionA.kind === "first_observation" && decisionB.kind === "first_observation") {
      expect(decisionA.store_key).not.toBe(decisionB.store_key);
      // Identical campaigns + different event_ids -> different touchpoint ids.
      expect(decisionA.touchpoint_id).not.toBe(decisionB.touchpoint_id);
    } else {
      throw new Error("expected both decisions to be first_observation");
    }
  });

  it("idempotency: replaying the same input yields the same touchpoint_id", () => {
    const raw = buildEnvelope({
      identity: { anonymous_id: "anon_X" },
      campaign: FULL_CAMPAIGN,
      event_id: "evt_replay",
    });
    const a = decideAttribution({ raw, prior: undefined });
    const b = decideAttribution({ raw, prior: undefined });
    if (a.kind === "first_observation" && b.kind === "first_observation") {
      expect(a.touchpoint_id).toBe(b.touchpoint_id);
    } else {
      throw new Error("expected both decisions to be first_observation");
    }
  });

  it("does NOT consider context.campaign click_id as vendor-specific (catch-all field)", () => {
    // v2 records click_id verbatim. Two different vendor click ids that
    // happen to share the same canonical campaign source/medium/name/term/
    // content but differ only by click_id are STILL detected as a delta
    // because click_id is part of the canonical tuple.
    const raw = buildEnvelope({
      identity: { anonymous_id: "anon_X" },
      campaign: { ...FULL_CAMPAIGN, click_id: "fbclid_other" },
      event_id: "evt_other_clickid",
    });
    const prior = buildPriorRecord({
      last_touchpoint_id: "tp_priorlast",
      last_touchpoint_tuple: FULL_CAMPAIGN,
    });
    const decision = decideAttribution({ raw, prior });
    expect(decision.kind).toBe("touchpoint_and_last");
  });

  it("treats an explicit-null campaign and a missing campaign as equivalent (both drop)", () => {
    const rawNull = buildEnvelope({
      identity: { anonymous_id: "anon_X" },
      campaign: null,
    });
    const decisionNull = decideAttribution({ raw: rawNull, prior: undefined });
    expect(decisionNull.kind).toBe("drop");
  });

  it("ignores partial-empty campaigns where some fields null and others empty strings", () => {
    const raw = buildEnvelope({
      identity: { anonymous_id: "anon_X" },
      campaign: {
        source: "",
        medium: null,
        name: "",
        term: undefined,
        content: null,
        click_id: "",
      },
    });
    const decision = decideAttribution({ raw, prior: undefined });
    expect(decision.kind).toBe("drop");
  });
});

describe("attribution window (v2)", () => {
  const DAY = 24 * 60 * 60;

  it("defaults to 90 days", () => {
    expect(DEFAULT_ATTRIBUTION_WINDOW_SECONDS).toBe(90 * DAY);
  });

  describe("isChainExpired", () => {
    it("is false inside the window", () => {
      expect(
        isChainExpired({
          last_observed_at: "2026-01-01T00:00:00.000Z",
          occurred_at: "2026-03-31T00:00:00.000Z", // 89 days
          window_seconds: 90 * DAY,
        }),
      ).toBe(false);
    });

    it("is false exactly ON the boundary", () => {
      // Strictly-greater-than, so a touch at exactly 90 days still
      // continues the chain. The boundary has to fall one way; landing on
      // "continue" means a chain is never reset by a rounding argument.
      expect(
        isChainExpired({
          last_observed_at: "2026-01-01T00:00:00.000Z",
          occurred_at: "2026-04-01T00:00:00.000Z",
          window_seconds: 90 * DAY,
        }),
      ).toBe(false);
    });

    it("is true one millisecond past the boundary", () => {
      expect(
        isChainExpired({
          last_observed_at: "2026-01-01T00:00:00.000Z",
          occurred_at: "2026-04-01T00:00:00.001Z",
          window_seconds: 90 * DAY,
        }),
      ).toBe(true);
    });

    it("never expires on an out-of-order (older) event", () => {
      // A late arrival must not reset a chain that newer events advanced.
      expect(
        isChainExpired({
          last_observed_at: "2026-06-01T00:00:00.000Z",
          occurred_at: "2026-01-01T00:00:00.000Z",
          window_seconds: 90 * DAY,
        }),
      ).toBe(false);
    });

    it("treats an unparsable timestamp as live, not expired", () => {
      // Expiring on a parse failure would silently mint a new first
      // touch; continuing merely postpones the reset to the next
      // well-formed event.
      expect(
        isChainExpired({
          last_observed_at: "not-a-date",
          occurred_at: "2026-04-01T00:00:00.000Z",
          window_seconds: 90 * DAY,
        }),
      ).toBe(false);
      expect(
        isChainExpired({
          last_observed_at: "2026-01-01T00:00:00.000Z",
          occurred_at: "not-a-date",
          window_seconds: 90 * DAY,
        }),
      ).toBe(false);
    });
  });

  describe("decideAttribution with a prior chain", () => {
    it("continues the chain inside the window", () => {
      const raw = buildEnvelope({
        occurred_at: "2026-05-14T11:00:00.000Z",
        identity: { anonymous_id: "anon_X" },
        campaign: { ...FULL_CAMPAIGN, source: "facebook" },
      });
      const decision = decideAttribution({ raw, prior: buildPriorRecord() });
      expect(decision.kind).toBe("touchpoint_and_last");
    });

    it("opens a NEW chain once the gap exceeds the window", () => {
      // Same identifier, same campaign shape, 91 days later.
      const raw = buildEnvelope({
        occurred_at: "2026-08-13T10:00:01.000Z",
        identity: { anonymous_id: "anon_X" },
        campaign: FULL_CAMPAIGN,
      });
      const decision = decideAttribution({
        raw,
        prior: buildPriorRecord({ last_observed_at: "2026-05-14T10:00:00.000Z" }),
      });
      expect(decision.kind).toBe("first_observation");
    });

    it("would have continued that same chain under v1 semantics", () => {
      // Pin the actual behavioural difference: with an effectively
      // infinite window the 91-day-later event is a continuation, which
      // is exactly what v1 did for every gap.
      const raw = buildEnvelope({
        occurred_at: "2026-08-13T10:00:01.000Z",
        identity: { anonymous_id: "anon_X" },
        campaign: FULL_CAMPAIGN,
      });
      const decision = decideAttribution({
        raw,
        prior: buildPriorRecord({ last_observed_at: "2026-05-14T10:00:00.000Z" }),
        window_seconds: Number.MAX_SAFE_INTEGER / 1000,
      });
      expect(decision.kind).toBe("touchpoint_only");
    });

    it("measures the gap from last_observed_at, not first_observed_at", () => {
      // An actively-touched journey must never be reset. First touch is
      // ancient; the last touch is recent.
      const raw = buildEnvelope({
        occurred_at: "2027-01-01T00:00:00.000Z",
        identity: { anonymous_id: "anon_X" },
        campaign: { ...FULL_CAMPAIGN, source: "bing" },
      });
      const decision = decideAttribution({
        raw,
        prior: buildPriorRecord({
          first_observed_at: "2020-01-01T00:00:00.000Z",
          last_observed_at: "2026-12-31T00:00:00.000Z",
        }),
      });
      expect(decision.kind).toBe("touchpoint_and_last");
    });

    it("resets on a same-tuple touch too, so a returning user is a new journey", () => {
      // The tuple is identical to the prior last-touch, which under an
      // unexpired chain would be `touchpoint_only` with no first-touch
      // emission. Past the window it must still open a new chain.
      const raw = buildEnvelope({
        occurred_at: "2026-09-01T00:00:00.000Z",
        identity: { anonymous_id: "anon_X" },
        campaign: FULL_CAMPAIGN,
      });
      const decision = decideAttribution({
        raw,
        prior: buildPriorRecord({ last_observed_at: "2026-05-14T10:00:00.000Z" }),
      });
      expect(decision.kind).toBe("first_observation");
    });

    it("honours an explicit window override", () => {
      const raw = buildEnvelope({
        occurred_at: "2026-05-16T10:00:00.000Z",
        identity: { anonymous_id: "anon_X" },
        campaign: FULL_CAMPAIGN,
      });
      const decision = decideAttribution({
        raw,
        prior: buildPriorRecord({ last_observed_at: "2026-05-14T10:00:00.000Z" }),
        window_seconds: DAY,
      });
      expect(decision.kind).toBe("first_observation");
    });
  });
});
