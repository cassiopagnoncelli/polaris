/**
 * Pure-transform tests for sessionizer v1.
 *
 * The transform decides between four branches (drop / start / continue /
 * expire_and_start) based on the canonical envelope and the prior store
 * record. These tests exercise each branch with deterministic inputs.
 */

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
    context: { ip: null, user_agent: null, locale: null, page: null, campaign: null },
    properties: {},
  };
}

function buildPriorRecord(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    session_id: "sess_abc123",
    project_id: "checkout",
    environment: "production",
    primary_identifier_kind: "anonymous_id",
    primary_identifier_value: "anon_X",
    started_at: "2026-05-12T11:30:00.000Z",
    last_seen_at: "2026-05-12T11:35:00.000Z",
    event_count: 5,
    source_event_id: "018f1b9e-aaaa-7b12-9a2e-0e2f88d8f551",
    ...overrides,
  };
}

describe("resolvePrimaryIdentifier", () => {
  it("prefers customer_id over anonymous_id and session_id", () => {
    const primary = resolvePrimaryIdentifier({
      anonymous_id: "anon_X",
      session_id: "sess_X",
      customer_id: "cus_Y",
      device_id: null,
    });
    expect(primary).toEqual({ kind: "customer_id", value: "cus_Y" });
  });

  it("falls back to anonymous_id when customer_id is missing", () => {
    const primary = resolvePrimaryIdentifier({
      anonymous_id: "anon_X",
      session_id: "sess_X",
      customer_id: null,
      device_id: null,
    });
    expect(primary).toEqual({ kind: "anonymous_id", value: "anon_X" });
  });

  it("falls back to session_id when only it is present", () => {
    const primary = resolvePrimaryIdentifier({
      anonymous_id: null,
      session_id: "sess_X",
      customer_id: null,
      device_id: null,
    });
    expect(primary).toEqual({ kind: "session_id", value: "sess_X" });
  });

  it("returns undefined when no usable identifier is present", () => {
    const primary = resolvePrimaryIdentifier({
      anonymous_id: null,
      session_id: null,
      customer_id: null,
      device_id: "dev_X",
    });
    expect(primary).toBeUndefined();
  });

  it("rejects empty strings", () => {
    const primary = resolvePrimaryIdentifier({
      anonymous_id: "",
      session_id: null,
      customer_id: null,
      device_id: null,
    });
    expect(primary).toBeUndefined();
  });

  it("recognises the documented preference order", () => {
    expect(PRIMARY_IDENTIFIER_KINDS).toEqual(["customer_id", "anonymous_id", "session_id"]);
  });
});

describe("deriveSessionId", () => {
  it("is deterministic for the same (primary, started_at)", () => {
    const a = deriveSessionId({
      primary: { kind: "anonymous_id", value: "anon_X" },
      started_at: "2026-05-12T12:00:00.000Z",
    });
    const b = deriveSessionId({
      primary: { kind: "anonymous_id", value: "anon_X" },
      started_at: "2026-05-12T12:00:00.000Z",
    });
    expect(a).toBe(b);
  });

  it("differs when the primary kind changes (anonymous vs customer same literal)", () => {
    const a = deriveSessionId({
      primary: { kind: "anonymous_id", value: "shared_value" },
      started_at: "2026-05-12T12:00:00.000Z",
    });
    const b = deriveSessionId({
      primary: { kind: "customer_id", value: "shared_value" },
      started_at: "2026-05-12T12:00:00.000Z",
    });
    expect(a).not.toBe(b);
  });

  it("differs when the started_at changes", () => {
    const a = deriveSessionId({
      primary: { kind: "anonymous_id", value: "anon_X" },
      started_at: "2026-05-12T12:00:00.000Z",
    });
    const b = deriveSessionId({
      primary: { kind: "anonymous_id", value: "anon_X" },
      started_at: "2026-05-12T13:00:00.000Z",
    });
    expect(a).not.toBe(b);
  });

  it("returns a sess_<hex> shape", () => {
    const id = deriveSessionId({
      primary: { kind: "anonymous_id", value: "anon_X" },
      started_at: "2026-05-12T12:00:00.000Z",
    });
    expect(id).toMatch(/^sess_[0-9a-f]+$/u);
  });
});

describe("buildSessionStoreKey", () => {
  it("includes project, environment, kind, and value", () => {
    const key = buildSessionStoreKey({
      project_id: "checkout",
      environment: "production",
      primary: { kind: "anonymous_id", value: "anon_X" },
    });
    expect(key).toBe("checkout::production::anonymous_id:anon_X");
  });

  it("treats customer_id and anonymous_id with the same value as different keys", () => {
    const a = buildSessionStoreKey({
      project_id: "checkout",
      environment: "production",
      primary: { kind: "anonymous_id", value: "shared" },
    });
    const b = buildSessionStoreKey({
      project_id: "checkout",
      environment: "production",
      primary: { kind: "customer_id", value: "shared" },
    });
    expect(a).not.toBe(b);
  });
});

describe("decideSession", () => {
  it("drops events with no usable identifier", () => {
    const raw = buildEnvelope({ identity: {} });
    const decision = decideSession({ raw, prior: undefined });
    expect(decision.kind).toBe("drop");
  });

  it("starts a new session when no prior record exists", () => {
    const raw = buildEnvelope({ identity: { anonymous_id: "anon_X" } });
    const decision = decideSession({ raw, prior: undefined });
    expect(decision.kind).toBe("start");
    if (decision.kind === "start") {
      expect(decision.primary).toEqual({ kind: "anonymous_id", value: "anon_X" });
      expect(decision.started_at).toBe(raw.occurred_at);
      expect(decision.store_key).toBe("checkout::production::anonymous_id:anon_X");
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

  it("keeps two different anonymous_id values isolated", () => {
    const rawA = buildEnvelope({
      identity: { anonymous_id: "anon_A" },
      occurred_at: "2026-05-12T11:35:00.000Z",
    });
    const rawB = buildEnvelope({
      identity: { anonymous_id: "anon_B" },
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

  it("falls back to anonymous_id when polaris_id (customer_id) is absent", () => {
    // The task's design language uses "polaris_id" for the platform-resolved
    // identity; in the canonical envelope, customer_id is the platform's
    // stable analogue. This test asserts the documented fallback behaviour.
    const raw = buildEnvelope({
      identity: { anonymous_id: "anon_X", customer_id: null },
    });
    const decision = decideSession({ raw, prior: undefined });
    expect(decision.kind).toBe("start");
    if (decision.kind === "start") {
      expect(decision.primary.kind).toBe("anonymous_id");
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
