import { describe, expect, it } from "vitest";

import { isoToEpochMicros, isoToEpochMs, isoToEpochSeconds } from "../src/index.js";

const ISO = "2026-05-11T12:00:00.000Z";
const ISO_EPOCH_MS = Date.parse(ISO);

describe("isoToEpochMs", () => {
  it("parses an ISO 8601 UTC string into milliseconds", () => {
    expect(isoToEpochMs(ISO)).toBe(ISO_EPOCH_MS);
  });

  it("is deterministic", () => {
    expect(isoToEpochMs(ISO)).toBe(isoToEpochMs(ISO));
  });

  it("throws on an unparseable input", () => {
    expect(() => isoToEpochMs("not a date")).toThrow();
  });
});

describe("isoToEpochSeconds", () => {
  it("returns seconds (Meta CAPI / TikTok shape)", () => {
    expect(isoToEpochSeconds(ISO)).toBe(Math.trunc(ISO_EPOCH_MS / 1000));
  });

  it("truncates fractional seconds toward zero", () => {
    // 12:00:00.500Z → still 12:00:00 in epoch seconds
    const isoFractional = "2026-05-11T12:00:00.500Z";
    const expected = Math.trunc(Date.parse(isoFractional) / 1000);
    expect(isoToEpochSeconds(isoFractional)).toBe(expected);
  });
});

describe("isoToEpochMicros", () => {
  it("returns microseconds (GA4 timestamp_micros shape)", () => {
    expect(isoToEpochMicros(ISO)).toBe(ISO_EPOCH_MS * 1000);
  });
});

describe("vendor divergence: Meta vs GA4 timestamp shape", () => {
  // Per the task acceptance criteria: cover at least one vendor-specific
  // divergence. Meta CAPI consumes `event_time` in epoch seconds; GA4
  // Measurement Protocol consumes `timestamp_micros` in epoch microseconds.
  it("produces distinct numeric forms for the same ISO input", () => {
    const seconds = isoToEpochSeconds(ISO);
    const micros = isoToEpochMicros(ISO);
    // 6-order-of-magnitude difference (seconds vs microseconds).
    expect(micros).toBe(seconds * 1_000_000);
    // The shapes are integers — vendor parsers reject decimal noise.
    expect(Number.isInteger(seconds)).toBe(true);
    expect(Number.isInteger(micros)).toBe(true);
  });
});
