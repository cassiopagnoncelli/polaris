import { describe, expect, it } from "vitest";

import {
  evaluate,
  mergePolicy,
  PLATFORM_DEFAULT_POLICY,
  POLICY_REASON_PII_ACCOUNT,
  POLICY_REASON_PII_CARD,
  POLICY_REASON_POLICY,
  PolicyMergeError,
  type ProjectPolicyOverride,
} from "../src/index.js";
import { buildEvent } from "./fixtures.js";

describe("mergePolicy — no override", () => {
  it("returns the platform defaults verbatim when no override is supplied", () => {
    const result = mergePolicy();
    expect(result.policy).toBe(PLATFORM_DEFAULT_POLICY);
    expect(result.override).toBeUndefined();
  });
});

describe("mergePolicy — additive overrides", () => {
  const override: ProjectPolicyOverride = {
    project_id: "checkout",
    reject: [{ field: "iban", reason: POLICY_REASON_PII_ACCOUNT }],
    redactNamed: [
      { field: "properties.email", reason: POLICY_REASON_POLICY },
      { field: "properties.phone", reason: POLICY_REASON_POLICY },
    ],
  };

  it("merges additional reject and redact entries onto the platform defaults", () => {
    const result = mergePolicy(override);
    const rejectFields = result.policy.reject.map((rule) => rule.field);
    const redactFields = result.policy.redactNamed.map((rule) => rule.field);
    expect(rejectFields).toContain("cvv");
    expect(rejectFields).toContain("iban");
    expect(redactFields).toContain("card_number");
    expect(redactFields).toContain("properties.email");
    expect(redactFields).toContain("properties.phone");
  });

  it("evaluates against the merged policy: project redact rule fires on email", () => {
    const event = buildEvent({
      properties: { email: "customer@example.com", amount: 100 },
    });
    const decision = evaluate(event, { projectPolicy: override });
    expect(decision.decision).toBe("accept");
    if (decision.decision !== "accept") return;
    const emailRedaction = decision.redactions.find((r) => r.path.join(".") === "properties.email");
    expect(emailRedaction).toBeDefined();
    expect(emailRedaction?.reason).toBe("policy");
  });

  it("evaluates against the merged policy: project reject rule fires on iban", () => {
    const event = buildEvent({
      properties: { iban: "DE89370400440532013000", amount: 100 },
    });
    const decision = evaluate(event, { projectPolicy: override });
    expect(decision.decision).toBe("reject");
    if (decision.decision !== "reject") return;
    expect(decision.reason).toBe("pii_account");
  });

  it("under platform defaults alone, the same event passes through", () => {
    const event = buildEvent({
      properties: { email: "customer@example.com" },
    });
    const decision = evaluate(event);
    expect(decision.decision).toBe("accept");
    if (decision.decision !== "accept") return;
    // Platform defaults do not redact email.
    expect(
      decision.redactions.find((r) => r.path.join(".") === "properties.email"),
    ).toBeUndefined();
  });
});

describe("mergePolicy — downgrade attempts", () => {
  it("rejects an override that attempts to downgrade a platform reject to a redact", () => {
    const override: ProjectPolicyOverride = {
      project_id: "evil-project",
      redactNamed: [{ field: "cvv", reason: POLICY_REASON_PII_CARD }],
    };
    expect(() => mergePolicy(override)).toThrow(PolicyMergeError);
  });

  it("permits a downgrade when documentedExceptions names the field", () => {
    const override: ProjectPolicyOverride = {
      project_id: "exempt-project",
      redactNamed: [{ field: "cvv", reason: POLICY_REASON_PII_CARD }],
      documentedExceptions: [
        {
          field: "cvv",
          rationale: "fraud-analytics sandbox; data is synthetic per PCI exemption #4",
          reviewer: "platform-security@example.internal",
          approved_at: "2026-05-01T00:00:00.000Z",
        },
      ],
    };
    expect(() => mergePolicy(override)).not.toThrow();
  });

  it("the merge error names the field and project but not the value", () => {
    const override: ProjectPolicyOverride = {
      project_id: "bad-project",
      redactNamed: [{ field: "cvv", reason: POLICY_REASON_PII_CARD }],
    };
    try {
      mergePolicy(override);
      throw new Error("merge should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("bad-project");
      expect(message).toContain("cvv");
      // Error must not carry anything that resembles a value.
      expect(message).not.toContain("123"); // generic synthetic value
    }
  });
});

describe("mergePolicy — dedupe", () => {
  it("dedupes identical platform-and-override entries", () => {
    const override: ProjectPolicyOverride = {
      project_id: "checkout",
      // Re-stating a platform reject does not double it.
      reject: [{ field: "cvv", reason: POLICY_REASON_PII_CARD }],
    };
    const result = mergePolicy(override);
    const cvvEntries = result.policy.reject.filter((r) => r.field.toLowerCase() === "cvv");
    expect(cvvEntries).toHaveLength(1);
  });

  it("dedupes pattern rules by tag", () => {
    const override: ProjectPolicyOverride = {
      project_id: "checkout",
      redactPatterns: [
        {
          pattern: "luhn_pan", // same tag as the platform detector
          reason: POLICY_REASON_PII_CARD,
          test: () => true,
        },
      ],
    };
    const result = mergePolicy(override);
    const luhnEntries = result.policy.redactPatterns.filter((r) => r.pattern === "luhn_pan");
    expect(luhnEntries).toHaveLength(1);
  });
});
