import { describe, expect, it } from "vitest";

import {
  assertValidCustomerId,
  assertValidEventName,
  assertValidProperties,
  normalizeOccurredAt,
  normalizeSchemaVersion,
  ValidationError,
} from "../src/internal/validation.js";

describe("assertValidEventName", () => {
  it("accepts canonical event names", () => {
    expect(() => assertValidEventName("payment.approved")).not.toThrow();
    expect(() => assertValidEventName("checkout.cart.updated")).not.toThrow();
    expect(() => assertValidEventName("experimental.foo.bar")).not.toThrow();
  });

  it.each([
    ["empty string", ""],
    ["single segment", "payment"],
    ["uppercase", "Payment.Approved"],
    ["non-snake", "payment.approvedNow"],
    ["dash", "payment.approved-fast"],
    ["non-string", 42 as unknown as string],
  ])("rejects %s", (_label, value) => {
    expect(() => assertValidEventName(value)).toThrowError(ValidationError);
  });
});

describe("assertValidProperties", () => {
  it("accepts plain objects and undefined", () => {
    expect(() => assertValidProperties(undefined)).not.toThrow();
    expect(() => assertValidProperties({})).not.toThrow();
    expect(() => assertValidProperties({ amount: 12 })).not.toThrow();
  });

  it("rejects arrays, null, and non-plain objects", () => {
    expect(() => assertValidProperties(null)).toThrowError(ValidationError);
    expect(() => assertValidProperties([])).toThrowError(ValidationError);
    expect(() => assertValidProperties(new Date())).toThrowError(ValidationError);
    expect(() => assertValidProperties("string")).toThrowError(ValidationError);
  });
});

describe("normalizeOccurredAt", () => {
  it("returns now when omitted", () => {
    const value = normalizeOccurredAt(undefined);
    expect(new Date(value).getTime()).not.toBeNaN();
  });

  it("formats Date inputs as ISO", () => {
    const value = normalizeOccurredAt(new Date("2026-05-12T12:34:56.789Z"));
    expect(value).toBe("2026-05-12T12:34:56.789Z");
  });

  it("rejects invalid Date", () => {
    expect(() => normalizeOccurredAt(new Date("not a date"))).toThrowError(ValidationError);
  });

  it("rejects unparseable string", () => {
    expect(() => normalizeOccurredAt("definitely not a date")).toThrowError(ValidationError);
  });
});

describe("normalizeSchemaVersion", () => {
  it("defaults to 1", () => {
    expect(normalizeSchemaVersion(undefined)).toBe(1);
  });
  it("accepts positive integers", () => {
    expect(normalizeSchemaVersion(3)).toBe(3);
  });
  it("rejects non-integers and zero/negatives", () => {
    expect(() => normalizeSchemaVersion(0)).toThrowError(ValidationError);
    expect(() => normalizeSchemaVersion(-1)).toThrowError(ValidationError);
    expect(() => normalizeSchemaVersion(1.5)).toThrowError(ValidationError);
  });
});

describe("assertValidCustomerId", () => {
  it("accepts non-empty strings", () => {
    expect(() => assertValidCustomerId("cus_123")).not.toThrow();
  });
  it("rejects empty/non-string/too-long", () => {
    expect(() => assertValidCustomerId("")).toThrowError(ValidationError);
    expect(() => assertValidCustomerId(undefined)).toThrowError(ValidationError);
    expect(() => assertValidCustomerId("a".repeat(129))).toThrowError(ValidationError);
  });
});
