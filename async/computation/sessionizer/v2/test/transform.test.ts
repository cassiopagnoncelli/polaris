/**
 * Pure-transform tests for sessionizer v1.
 *
 * The transform decides between four branches (drop / start / continue /
 * expire_and_start) based on the canonical envelope and the prior store
 * record. These tests exercise each branch with deterministic inputs.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildSessionStoreKey,
  DEFAULT_INACTIVITY_SECONDS,
  decideSession,
  deriveSessionId,
  PRIMARY_IDENTIFIER_KINDS,
  resolvePrimaryIdentifier,
  type SessionRecord,
} from "../src/transform.js";
import type { RawEventEnvelope } from "../src/types.js";

function buildEnvelope(overrides: {
  readonly event_id?: string;
  readonly occurred_at?: string;
  readonly project_id?: string;
  readonly environment?: string;
  readonly identity?: Partial<RawEventEnvelope["identity"]>;
  readonly profile_id?: string | null;
}): RawEventEnvelope {
  const identity: RawEventEnvelope["identity"] = {
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
    occurred_at: overrides.occurred_at ?? "2026-05-12T12:00:00.000Z",
    ingested_at: "2026-05-12T12:00:01.000Z",
    source: { type: "browser", id: "web", sdk: "web", sdk_version: "1.0.0" },
    identity,
    profile:
      overrides.profile_id === null
        ? null
        : { profile_id: overrides.profile_id ?? "01a00000-0000-7000-8000-00000000f001" },
    context: { ip: null, user_agent: null, locale: null, page: null, campaign: null },
    properties: {},
  };
}

function buildPriorRecord(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    session_id: "sess_abc123",
    project_id: "checkout",
    environment: "production",
    primary_identifier_kind: "profile_id",
    primary_identifier_value: "01a00000-0000-7000-8000-00000000f001",
    started_at: "2026-05-12T11:30:00.000Z",
    last_seen_at: "2026-05-12T11:35:00.000Z",
    event_count: 5,
    source_event_id: "018f1b9e-aaaa-7b12-9a2e-0e2f88d8f551",
    ...overrides,
  };
}

describe("resolvePrimaryIdentifier", () => {
  it("keys on the person the identity stage stamped", () => {
    const primary = resolvePrimaryIdentifier({
      profile_id: "01a00000-0000-7000-8000-00000000f001",
    });
    expect(primary).toEqual({
      kind: "profile_id",
      value: "01a00000-0000-7000-8000-00000000f001",
    });
  });

  it("ignores the identity block entirely — that question is answered upstream", () => {
    // v1 walked customer_id > anonymous_id > session_id and keyed on
    // whichever was present, which is what orphaned a session at every
    // login. v2 has one input and no fallback: re-adding one would
    // reintroduce the key-switching this version exists to remove.
    expect(resolvePrimaryIdentifier(null)).toBeUndefined();
    expect(resolvePrimaryIdentifier(undefined)).toBeUndefined();
    expect(resolvePrimaryIdentifier({})).toBeUndefined();
  });

  it("rejects an empty or non-string profile id", () => {
    expect(resolvePrimaryIdentifier({ profile_id: "" })).toBeUndefined();
    expect(resolvePrimaryIdentifier({ profile_id: null })).toBeUndefined();
  });

  it("declares exactly one identifier kind", () => {
    expect([...PRIMARY_IDENTIFIER_KINDS]).toEqual(["profile_id"]);
  });
});

describe("deriveSessionId", () => {
  it("is deterministic for the same (primary, started_at)", () => {
    const a = deriveSessionId({
      primary: { kind: "profile_id", value: "01a00000-0000-7000-8000-00000000f001" },
      started_at: "2026-05-12T12:00:00.000Z",
    });
    const b = deriveSessionId({
      primary: { kind: "profile_id", value: "01a00000-0000-7000-8000-00000000f001" },
      started_at: "2026-05-12T12:00:00.000Z",
    });
    expect(a).toBe(b);
  });

  it("differs between two people, so windows never share an id", () => {
    const a = deriveSessionId({
      primary: { kind: "profile_id", value: "01a00000-0000-7000-8000-00000000f001" },
      started_at: "2026-05-12T12:00:00.000Z",
    });
    const b = deriveSessionId({
      primary: { kind: "profile_id", value: "01a00000-0000-7000-8000-00000000f002" },
      started_at: "2026-05-12T12:00:00.000Z",
    });
    expect(a).not.toBe(b);
  });

  it("is domain-separated from v1, so coexisting versions never collide", () => {
    // Both versions run during the R2C cutover and both see the same
    // person. A shared derivation would mint one id for two windows that
    // deliberately mean different things — v1's keyed on an identifier,
    // v2's on the person.
    const material = "polaris/sessionizer/v2/profile_id:";
    expect(
      deriveSessionId({
        primary: { kind: "profile_id", value: "x" },
        started_at: "2026-05-12T12:00:00.000Z",
      }),
    ).toBe(
      `sess_${createHash("sha256")
        .update(`${material}x/2026-05-12T12:00:00.000Z`, "utf8")
        .digest("hex")
        .slice(0, 32)}`,
    );
  });

  it("differs when the started_at changes", () => {
    const a = deriveSessionId({
      primary: { kind: "profile_id", value: "01a00000-0000-7000-8000-00000000f001" },
      started_at: "2026-05-12T12:00:00.000Z",
    });
    const b = deriveSessionId({
      primary: { kind: "profile_id", value: "01a00000-0000-7000-8000-00000000f001" },
      started_at: "2026-05-12T13:00:00.000Z",
    });
    expect(a).not.toBe(b);
  });

  it("returns a sess_<hex> shape", () => {
    const id = deriveSessionId({
      primary: { kind: "profile_id", value: "01a00000-0000-7000-8000-00000000f001" },
      started_at: "2026-05-12T12:00:00.000Z",
    });
    expect(id).toMatch(/^sess_[0-9a-f]+$/u);
  });
});

describe("buildSessionStoreKey", () => {
  it("scopes the person by project and environment", () => {
    expect(
      buildSessionStoreKey({
        project_id: "checkout",
        environment: "production",
        primary: { kind: "profile_id", value: "01a00000-0000-7000-8000-00000000f001" },
      }),
    ).toBe("checkout::production::01a00000-0000-7000-8000-00000000f001");
  });

  it("keeps the same person separate across environments", () => {
    // Profiles are project- and environment-scoped in the store, so the
    // key must be too — a production session must never continue a
    // staging one.
    const primary = { kind: "profile_id", value: "01a00000-0000-7000-8000-00000000f001" } as const;
    expect(
      buildSessionStoreKey({ project_id: "checkout", environment: "production", primary }),
    ).not.toBe(buildSessionStoreKey({ project_id: "checkout", environment: "staging", primary }));
  });
});

describe("decideSession", () => {
  it("drops an event the identity stage could not resolve to a person", () => {
    const raw = buildEnvelope({ profile_id: null });
    const decision = decideSession({ raw, prior: undefined });
    expect(decision.kind).toBe("drop");
  });

  it("starts a new session when no prior record exists", () => {
    const raw = buildEnvelope({ identity: { anonymous_id: "anon_X" } });
    const decision = decideSession({ raw, prior: undefined });
    expect(decision.kind).toBe("start");
    if (decision.kind === "start") {
      expect(decision.primary).toEqual({
        kind: "profile_id",
        value: "01a00000-0000-7000-8000-00000000f001",
      });
      expect(decision.started_at).toBe(raw.occurred_at);
      expect(decision.store_key).toBe("checkout::production::01a00000-0000-7000-8000-00000000f001");
      expect(decision.session_id).toMatch(/^sess_[0-9a-f]+$/u);
    }
  });

  it("continues an active session when the event lands inside the inactivity window", () => {
    const raw = buildEnvelope({
      identity: { anonymous_id: "anon_X" },
      // 5 minutes after the prior last_seen_at — well within the 30 min window.
      occurred_at: "2026-05-12T11:40:00.000Z",
    });
    const prior = buildPriorRecord({});
    const decision = decideSession({ raw, prior });
    expect(decision.kind).toBe("continue");
    if (decision.kind === "continue") {
      expect(decision.session_id).toBe(prior.session_id);
      expect(decision.started_at).toBe(prior.started_at);
    }
  });

  it("starts a new session when the inactivity window has elapsed (lazy expiration)", () => {
    const raw = buildEnvelope({
      identity: { anonymous_id: "anon_X" },
      // 31 minutes after last_seen_at — past the 30 min boundary.
      occurred_at: "2026-05-12T12:06:00.000Z",
    });
    const prior = buildPriorRecord({
      last_seen_at: "2026-05-12T11:35:00.000Z",
    });
    const decision = decideSession({ raw, prior });
    expect(decision.kind).toBe("expire_and_start");
    if (decision.kind === "expire_and_start") {
      expect(decision.ended.session_id).toBe(prior.session_id);
      expect(decision.ended.event_count).toBe(prior.event_count);
      expect(decision.ended.last_seen_at).toBe(prior.last_seen_at);
      // ended_at is anchored to last_seen_at + inactivity_seconds (1800).
      expect(decision.ended.ended_at).toBe("2026-05-12T12:05:00.000Z");

      // The new session starts on the current event's occurred_at.
      expect(decision.started.started_at).toBe(raw.occurred_at);
      expect(decision.started.session_id).not.toBe(prior.session_id);
    }
  });

  it("uses a configurable inactivity_seconds override", () => {
    const raw = buildEnvelope({
      identity: { anonymous_id: "anon_X" },
      // 31 seconds after last_seen_at — past a 30-second window.
      occurred_at: "2026-05-12T11:35:31.000Z",
    });
    const prior = buildPriorRecord({
      last_seen_at: "2026-05-12T11:35:00.000Z",
    });
    const decision = decideSession({ raw, prior, inactivity_seconds: 30 });
    expect(decision.kind).toBe("expire_and_start");
  });

  it("defaults inactivity to 30 minutes", () => {
    expect(DEFAULT_INACTIVITY_SECONDS).toBe(1800);
  });

  it("keeps two different people isolated", () => {
    const rawA = buildEnvelope({
      identity: { anonymous_id: "anon_A" },
      profile_id: "01a00000-0000-7000-8000-00000000f001",
      occurred_at: "2026-05-12T11:35:00.000Z",
    });
    const rawB = buildEnvelope({
      identity: { anonymous_id: "anon_B" },
      profile_id: "01a00000-0000-7000-8000-00000000f002",
      occurred_at: "2026-05-12T11:35:00.000Z",
    });
    const decisionA = decideSession({ raw: rawA, prior: undefined });
    const decisionB = decideSession({ raw: rawB, prior: undefined });
    if (decisionA.kind === "start" && decisionB.kind === "start") {
      expect(decisionA.session_id).not.toBe(decisionB.session_id);
      expect(decisionA.store_key).not.toBe(decisionB.store_key);
    } else {
      throw new Error("expected both decisions to start a session");
    }
  });

  it("keys on the person regardless of which identifiers the event carries", () => {
    // The task's design language uses "polaris_id" for the platform-resolved
    // identity; in the canonical envelope, customer_id is the platform's
    // stable analogue. This test asserts the documented fallback behaviour.
    const raw = buildEnvelope({
      identity: { anonymous_id: "anon_X", customer_id: null },
    });
    const decision = decideSession({ raw, prior: undefined });
    expect(decision.kind).toBe("start");
    if (decision.kind === "start") {
      expect(decision.primary.kind).toBe("profile_id");
    }
  });

  it("idempotency: replaying the same input yields the same session_id", () => {
    const raw = buildEnvelope({
      identity: { anonymous_id: "anon_X" },
      occurred_at: "2026-05-12T12:00:00.000Z",
    });
    const a = decideSession({ raw, prior: undefined });
    const b = decideSession({ raw, prior: undefined });
    if (a.kind === "start" && b.kind === "start") {
      expect(a.session_id).toBe(b.session_id);
    } else {
      throw new Error("expected both decisions to start");
    }
  });

  it("ignores SDK session_id as a hint when a stronger identifier is present", () => {
    // A campaign change re-emits a new SDK session_id but the anonymous_id
    // stays the same. The sessionizer must NOT rotate its own session on
    // that signal — its session_id is keyed on anonymous_id + started_at.
    const rawOne = buildEnvelope({
      identity: { anonymous_id: "anon_X", session_id: "sdk_sess_A" },
      occurred_at: "2026-05-12T12:00:00.000Z",
    });
    const rawTwo = buildEnvelope({
      identity: { anonymous_id: "anon_X", session_id: "sdk_sess_B" },
      occurred_at: "2026-05-12T12:01:00.000Z",
    });
    const decisionOne = decideSession({ raw: rawOne, prior: undefined });
    expect(decisionOne.kind).toBe("start");
    if (decisionOne.kind !== "start") return;

    const priorAfterFirst: SessionRecord = {
      session_id: decisionOne.session_id,
      project_id: rawOne.project_id,
      environment: rawOne.environment,
      primary_identifier_kind: decisionOne.primary.kind,
      primary_identifier_value: decisionOne.primary.value,
      started_at: decisionOne.started_at,
      last_seen_at: rawOne.occurred_at,
      event_count: 1,
      source_event_id: rawOne.event_id,
    };
    const decisionTwo = decideSession({ raw: rawTwo, prior: priorAfterFirst });
    expect(decisionTwo.kind).toBe("continue");
    if (decisionTwo.kind === "continue") {
      expect(decisionTwo.session_id).toBe(decisionOne.session_id);
    }
  });

  it("starts a fresh session on an event older than the prior session_started_at (replay safety)", () => {
    const raw = buildEnvelope({
      identity: { anonymous_id: "anon_X" },
      occurred_at: "2026-05-12T10:00:00.000Z",
    });
    const prior = buildPriorRecord({
      started_at: "2026-05-12T11:30:00.000Z",
      last_seen_at: "2026-05-12T11:35:00.000Z",
    });
    const decision = decideSession({ raw, prior });
    expect(decision.kind).toBe("start");
  });
});
