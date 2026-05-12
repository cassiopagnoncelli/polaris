import { describe, expect, it } from "vitest";

import {
  DEFAULT_CURRENCY_EXPONENT,
  exponentForCurrency,
  majorToMinor,
  minorToMajor,
} from "../src/index.js";

describe("exponentForCurrency", () => {
  it("returns 2 for standard 2-decimal currencies", () => {
    expect(exponentForCurrency("USD")).toBe(2);
    expect(exponentForCurrency("BRL")).toBe(2);
    expect(exponentForCurrency("EUR")).toBe(2);
  });

  it("returns 0 for JPY and other 0-decimal currencies", () => {
    expect(exponentForCurrency("JPY")).toBe(0);
    expect(exponentForCurrency("KRW")).toBe(0);
    expect(exponentForCurrency("VND")).toBe(0);
  });

  it("returns 3 for 3-decimal currencies", () => {
    expect(exponentForCurrency("BHD")).toBe(3);
    expect(exponentForCurrency("KWD")).toBe(3);
  });

  it("is case-insensitive on the code", () => {
    expect(exponentForCurrency("jpy")).toBe(0);
    expect(exponentForCurrency(" usd ")).toBe(2);
  });

  it("falls back to the default exponent for unknown codes", () => {
    expect(exponentForCurrency("XYZ")).toBe(DEFAULT_CURRENCY_EXPONENT);
  });
});

describe("minorToMajor", () => {
  it("converts 2-decimal minor to major", () => {
    expect(minorToMajor(12990, "BRL")).toBe(129.9);
    expect(minorToMajor(100, "USD")).toBe(1);
    expect(minorToMajor(0, "USD")).toBe(0);
  });

  it("passes 0-decimal currencies through unchanged", () => {
    expect(minorToMajor(50000, "JPY")).toBe(50000);
  });

  it("handles 3-decimal currencies", () => {
    expect(minorToMajor(1000, "BHD")).toBe(1);
    expect(minorToMajor(12345, "KWD")).toBe(12.345);
  });

  it("accepts an explicit exponent override", () => {
    expect(minorToMajor(12345, "USD", 4)).toBe(1.2345);
  });

  it("rejects non-integer minor amounts", () => {
    expect(() => minorToMajor(12.5, "USD")).toThrow();
    expect(() => minorToMajor(Number.NaN, "USD")).toThrow();
  });
});

describe("majorToMinor", () => {
  it("converts major to minor (2-decimal)", () => {
    expect(majorToMinor(129.9, "BRL")).toBe(12990);
    expect(majorToMinor(0.01, "USD")).toBe(1);
  });

  it("passes 0-decimal currencies through unchanged", () => {
    expect(majorToMinor(50000, "JPY")).toBe(50000);
  });

  it("rounds correctly at the boundary", () => {
    expect(majorToMinor(129.995, "USD")).toBe(13000);
  });
});

describe("vendor divergence: JPY vs USD", () => {
  // Per the task acceptance criteria: cover at least one vendor-specific
  // divergence. JPY (0-decimal) and USD (2-decimal) behave differently
  // in minor↔major conversion; mappers that target Meta CAPI Purchase
  // and GA4 `purchase` must produce different value representations.
  it("treats JPY differently from USD even for the same numeric value", () => {
    expect(minorToMajor(100, "USD")).toBe(1);
    expect(minorToMajor(100, "JPY")).toBe(100);
  });
});
