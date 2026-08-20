import { describe, expect, it } from "vitest";

import {
  isPolicyReasonCode,
  POLICY_BATCH_REASON_FORBIDDEN_FIELD_REJECTED,
  POLICY_REASON_CODES,
  POLICY_REASON_LENGTH,
  POLICY_REASON_PATTERN_MATCH,
  POLICY_REASON_PII_ACCOUNT,
  POLICY_REASON_PII_CARD,
  POLICY_REASON_PII_SECRET,
  POLICY_REASON_POLICY,
} from "../src/index.js";

describe("policy reason codes", () => {
  it("exports the closed set in a stable order", () => {
    expect(POLICY_REASON_CODES).toEqual([
      "pii_card",
      "pii_account",
      "pii_secret",
      "policy",
      "length",
      "pattern_match",
    ]);
  });

  it("exports each constant individually", () => {
    expect(POLICY_REASON_PII_CARD).toBe("pii_card");
    expect(POLICY_REASON_PII_ACCOUNT).toBe("pii_account");
    expect(POLICY_REASON_PII_SECRET).toBe("pii_secret");
    expect(POLICY_REASON_POLICY).toBe("policy");
    expect(POLICY_REASON_LENGTH).toBe("length");
    expect(POLICY_REASON_PATTERN_MATCH).toBe("pattern_match");
  });

  it("exposes the batch-response reject reason as a sibling constant", () => {
    expect(POLICY_BATCH_REASON_FORBIDDEN_FIELD_REJECTED).toBe("forbidden_field_rejected");
  });

  it("isPolicyReasonCode accepts every known reason", () => {
    for (const code of POLICY_REASON_CODES) {
      expect(isPolicyReasonCode(code)).toBe(true);
    }
  });

  it("isPolicyReasonCode rejects unknown values", () => {
    expect(isPolicyReasonCode("unknown")).toBe(false);
    expect(isPolicyReasonCode(undefined)).toBe(false);
    expect(isPolicyReasonCode(null)).toBe(false);
    expect(isPolicyReasonCode(0)).toBe(false);
    expect(isPolicyReasonCode("PII_CARD")).toBe(false); // case-sensitive
  });
});
