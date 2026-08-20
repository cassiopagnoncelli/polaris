import { describe, expect, it } from "vitest";

import {
  applySecondPassRedactions,
  DROP_REASONS,
  type DropReason,
  hashEmailLower,
  isoToEpochMs,
  type NormalizeOptions,
  normalizeForDestination,
} from "../src/index.js";
import { buildEnvelope } from "./fixtures.js";

const baseOptions: NormalizeOptions = {
  destinationId: "polaris_dst_test",
  requiredConsent: {},
};

describe("normalizeForDestination — happy path", () => {
  it("emits a normalized event for a full envelope", () => {
    const envelope = buildEnvelope({
      identity: {
        anonymous_id: "anon_xyz",
        session_id: null,
        customer_id: "cus_001",
        device_id: null,
      },
      consent: { marketing: true, analytics: true, personalization: true },
      context: {
        ip: "203.0.113.10",
        user_agent: "Mozilla/5.0 ...",
        locale: "pt-BR",
        page: { url: "https://example.com/checkout", path: "/checkout" },
        campaign: { source: "google", medium: "cpc" },
      },
    });

    const outcome = normalizeForDestination(envelope, {
      destinationId: "polaris_dst_meta_capi_001",
      requiredConsent: { marketing: true },
      identityHashing: { email: true, phone: true },
      identityFromProperties: () => ({
        email: "ALICE@Example.COM",
        phone: "+15555550123",
      }),
    });

    expect(outcome.kind).toBe("normalized");
    if (outcome.kind !== "normalized") return;
    const n = outcome.normalized;
    expect(n.destination_id).toBe("polaris_dst_meta_capi_001");
    expect(n.event_id).toBe(envelope.event_id);
    expect(n.event).toBe("payment.approved");
    expect(n.project_id).toBe("checkout");
    expect(n.environment).toBe("production");
    expect(n.occurred_at).toBe(envelope.occurred_at);
    expect(n.occurred_at_epoch_ms).toBe(isoToEpochMs(envelope.occurred_at));
    expect(n.identity.user_id).toBe("cus_001");
    expect(n.identity.email_sha256).toBe(hashEmailLower("alice@example.com"));
    expect(n.best_identity.kind).toBe("user_id");
    expect(n.best_identity.value).toBe("cus_001");
    expect(n.context.ip).toBe("203.0.113.10");
    expect(n.context.page_url).toBe("https://example.com/checkout");
    expect(n.context.campaign_source).toBe("google");
    expect(n.consent.status).toBe("granted");
  });

  it("does not mutate the input envelope", () => {
    const envelope = buildEnvelope({
      properties: { amount: 12990, currency: "BRL" },
    });
    const before = JSON.stringify(envelope);
    normalizeForDestination(envelope, baseOptions);
    expect(JSON.stringify(envelope)).toBe(before);
  });
});

describe("normalizeForDestination — consent_not_granted", () => {
  it("drops when a required consent dimension is explicitly false", () => {
    const envelope = buildEnvelope({
      consent: { marketing: false, analytics: true },
    });
    const outcome = normalizeForDestination(envelope, {
      ...baseOptions,
      requiredConsent: { marketing: true },
    });
    expect(outcome.kind).toBe("drop");
    if (outcome.kind !== "drop") return;
    expect(outcome.reason).toBe("consent_not_granted");
    expect(outcome.detail).toBe("dimension marketing");
  });

  it("does not drop when consent.marketing is absent (absent-as-true)", () => {
    const envelope = buildEnvelope();
    delete (envelope as { consent?: unknown }).consent;
    const outcome = normalizeForDestination(envelope, {
      ...baseOptions,
      requiredConsent: { marketing: true },
    });
    expect(outcome.kind).toBe("normalized");
  });
});

describe("normalizeForDestination — no_usable_identity", () => {
  it("drops when the identity block has no usable fields", () => {
    const envelope = buildEnvelope({
      identity: {
        anonymous_id: null,
        session_id: null,
        customer_id: null,
        device_id: null,
      },
    });
    const outcome = normalizeForDestination(envelope, baseOptions);
    expect(outcome.kind).toBe("drop");
    if (outcome.kind !== "drop") return;
    expect(outcome.reason).toBe("no_usable_identity");
  });

  it("does not drop when only anonymous_id is present", () => {
    const envelope = buildEnvelope({
      identity: {
        anonymous_id: "anon_xyz",
        session_id: null,
        customer_id: null,
        device_id: null,
      },
    });
    const outcome = normalizeForDestination(envelope, baseOptions);
    expect(outcome.kind).toBe("normalized");
    if (outcome.kind !== "normalized") return;
    expect(outcome.normalized.best_identity.kind).toBe("anonymous_id");
  });
});

describe("normalizeForDestination — invalid_envelope", () => {
  it("drops when occurred_at is malformed", () => {
    const envelope = buildEnvelope({ occurred_at: "not-a-date" });
    const outcome = normalizeForDestination(envelope, baseOptions);
    expect(outcome.kind).toBe("drop");
    if (outcome.kind !== "drop") return;
    expect(outcome.reason).toBe("invalid_envelope");
  });

  it("drops when event_id is empty", () => {
    const envelope = buildEnvelope({ event_id: "" });
    const outcome = normalizeForDestination(envelope, baseOptions);
    expect(outcome.kind).toBe("drop");
    if (outcome.kind !== "drop") return;
    expect(outcome.reason).toBe("invalid_envelope");
  });
});

describe("DROP_REASONS export", () => {
  it("is the closed-set list of drop reasons", () => {
    const expected: readonly DropReason[] = [
      "consent_not_granted",
      "no_usable_identity",
      "invalid_envelope",
      "redacted_payload_empty",
    ];
    expect(DROP_REASONS).toEqual(expected);
  });
});

describe("applySecondPassRedactions", () => {
  it("returns the envelope reference unchanged when no rules fire", () => {
    const envelope = buildEnvelope({
      properties: { amount: 100, currency: "USD" },
    });
    const result = applySecondPassRedactions(envelope);
    expect(result.kind).toBe("redacted");
    if (result.kind !== "redacted") return;
    // Clean envelope: same reference (no needless clone).
    expect(result.envelope).toBe(envelope);
    // No redactions to emit metrics for.
    expect(result.redactions).toEqual([]);
  });

  it("redacts a JWT-shaped value in properties and returns a clone", () => {
    // A JWT-shaped value in `properties` (outside identity.*) triggers
    // the JWT pattern detector in `@polaris/shared-policy`.
    const jwtShape =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const envelope = buildEnvelope({
      properties: { amount: 100, currency: "USD", session_proof: jwtShape },
    });
    const result = applySecondPassRedactions(envelope);
    expect(result.kind).toBe("redacted");
    if (result.kind !== "redacted") return;
    // Cloned (different reference).
    expect(result.envelope).not.toBe(envelope);
    expect((result.envelope.properties as { session_proof?: string }).session_proof).toBe(
      "[REDACTED:pii_secret]",
    );
    // Original is untouched.
    expect((envelope.properties as { session_proof?: string }).session_proof).toBe(jwtShape);
    // The redaction action surfaces so the consumer runtime can emit
    // `polaris_ingest_redacted_pattern_total`.
    expect(result.redactions).toHaveLength(1);
    const action = result.redactions[0];
    expect(action?.path).toEqual(["properties", "session_proof"]);
    expect(action?.reason).toBe("pii_secret");
    expect(action?.source).toBe("pattern");
    expect(action?.pattern).toBe("jwt");
    // Metric label-safety: the redaction action never carries the raw
    // pre-redaction value. The serialized form must not contain any
    // segment of the original JWT.
    const serialized = JSON.stringify(action);
    expect(serialized).not.toContain(jwtShape);
    expect(serialized).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(serialized).not.toContain("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c");
  });

  it("rejects when the policy declares a reject rule that fires", () => {
    // A `password` field in `properties` is a platform reject rule.
    const envelope = buildEnvelope({
      properties: { amount: 100, currency: "USD", password: "hunter2" },
    });
    const result = applySecondPassRedactions(envelope);
    expect(result.kind).toBe("reject");
    if (result.kind !== "reject") return;
    expect(result.path).toEqual(["properties", "password"]);
  });

  it("surfaces redaction actions safe to feed emitRedactionMetric (label set)", async () => {
    // Per the task brief: a pattern-based redaction at the destination
    // boundary must be observable through the shared metric. This test
    // asserts the labels emitted by `emitRedactionMetric` for the
    // returned action set carry no raw value.
    const { emitAllRedactionMetrics } = await import("@polaris/shared-policy");
    const jwtShape =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const envelope = buildEnvelope({
      properties: { amount: 100, currency: "USD", token: jwtShape },
    });
    const result = applySecondPassRedactions(envelope);
    expect(result.kind).toBe("redacted");
    if (result.kind !== "redacted") return;
    const increments = emitAllRedactionMetrics(result.redactions, {
      project_id: envelope.project_id,
      environment: envelope.environment,
    });
    expect(increments).toHaveLength(1);
    const labels = increments[0]?.labels;
    expect(labels).toEqual({
      project_id: "checkout",
      environment: "production",
      reason: "pii_secret",
      pattern: "jwt",
    });
    // Defensive: no raw value leaks into the label set.
    expect(JSON.stringify(labels)).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });
});

describe("normalizeForDestination — applySecondPassRedactions integration", () => {
  it("redacts a JWT-shaped value in properties at the destination boundary", () => {
    const jwtShape =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const envelope = buildEnvelope({
      properties: { amount: 100, currency: "USD", token: jwtShape },
    });
    const outcome = normalizeForDestination(envelope, baseOptions);
    expect(outcome.kind).toBe("normalized");
    if (outcome.kind !== "normalized") return;
    expect((outcome.normalized.properties as { token?: string }).token).toBe(
      "[REDACTED:pii_secret]",
    );
    // The envelope passed in was not mutated.
    expect((envelope.properties as { token?: string }).token).toBe(jwtShape);
  });

  it("drops with redacted_payload_empty when a reject rule fires", () => {
    const envelope = buildEnvelope({
      properties: { amount: 100, currency: "USD", password: "hunter2" },
    });
    const outcome = normalizeForDestination(envelope, baseOptions);
    expect(outcome.kind).toBe("drop");
    if (outcome.kind !== "drop") return;
    expect(outcome.reason).toBe("redacted_payload_empty");
    expect(outcome.detail).toMatch(/properties\.password/);
  });
});
