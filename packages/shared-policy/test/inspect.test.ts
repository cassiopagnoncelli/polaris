import { describe, expect, it } from "vitest";

import {
  POLICY_REASON_PII_ACCOUNT,
  POLICY_REASON_POLICY,
  type ProjectPolicyOverride,
  formatPolicyInspection,
  inspectPolicy,
} from "../src/index.js";

describe("inspectPolicy", () => {
  it("returns platform-only counts when no override is supplied", () => {
    const inspection = inspectPolicy();
    expect(inspection.project_id).toBeUndefined();
    expect(inspection.counts.reject_project).toBe(0);
    expect(inspection.counts.redact_named_project).toBe(0);
    expect(inspection.counts.redact_patterns_project).toBe(0);
    expect(inspection.counts.reject_platform).toBeGreaterThan(0);
    expect(inspection.counts.redact_named_platform).toBe(1);
    expect(inspection.counts.redact_patterns_platform).toBe(5);
    expect(inspection.exceptions).toEqual([]);
  });

  it("attributes override entries to the project count", () => {
    const override: ProjectPolicyOverride = {
      project_id: "checkout",
      reject: [{ field: "iban", reason: POLICY_REASON_PII_ACCOUNT }],
      redactNamed: [{ field: "properties.email", reason: POLICY_REASON_POLICY }],
    };
    const inspection = inspectPolicy(override);
    expect(inspection.project_id).toBe("checkout");
    expect(inspection.counts.reject_project).toBe(1);
    expect(inspection.counts.redact_named_project).toBe(1);
    expect(inspection.counts.reject_total).toBe(
      inspection.counts.reject_platform + inspection.counts.reject_project,
    );
  });

  it("exposes documented exceptions when present", () => {
    const override: ProjectPolicyOverride = {
      project_id: "exempt-project",
      redactNamed: [{ field: "cvv", reason: "pii_card" }],
      documentedExceptions: [
        {
          field: "cvv",
          rationale: "sandbox tenant; values are synthetic only",
          reviewer: "security@example.internal",
          approved_at: "2026-05-01T00:00:00.000Z",
        },
      ],
    };
    const inspection = inspectPolicy(override);
    expect(inspection.exceptions).toHaveLength(1);
    expect(inspection.exceptions[0]?.field).toBe("cvv");
  });
});

describe("formatPolicyInspection", () => {
  it("renders a multi-line, value-free human-readable report", () => {
    const text = formatPolicyInspection(inspectPolicy());
    expect(text).toContain("Effective forbidden-field policy");
    expect(text).toContain("Reject (");
    expect(text).toContain("Redact (named)");
    expect(text).toContain("Redact (pattern)");
    expect(text).toContain("luhn_pan");
    // No event values appear; the report is policy metadata only.
    expect(text).not.toContain("REDACTED:");
  });

  it("includes the project header when an override is in scope", () => {
    const override: ProjectPolicyOverride = {
      project_id: "checkout",
      redactNamed: [{ field: "properties.email", reason: POLICY_REASON_POLICY }],
    };
    const text = formatPolicyInspection(inspectPolicy(override));
    expect(text).toContain("project 'checkout'");
    expect(text).toContain("properties.email");
  });
});
