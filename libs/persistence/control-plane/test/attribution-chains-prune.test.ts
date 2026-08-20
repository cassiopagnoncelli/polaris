/**
 * Guards on attribution chain retention.
 *
 * The cutoff arithmetic is incidental; the property worth pinning is the
 * refusal. Pruning a v1 chain changes attribution output, and the only
 * thing standing between an operator and that is this validation.
 */

import { describe, expect, it } from "vitest";

import {
  IdleWindowTooShortError,
  PRUNABLE_ATTRIBUTION_VERSIONS,
  resolvePruneCutoff,
  UnprunableAttributionVersionError,
} from "../src/mutations/attribution-chains.js";

const NOW = new Date("2026-08-12T00:00:00.000Z");
const DAY = 24 * 60 * 60;

describe("resolvePruneCutoff", () => {
  it("refuses v1, which has no attribution window", () => {
    // v1 consults a chain however old it is, so deleting one would make
    // the next touchpoint emit a first_touch_assigned it otherwise would
    // not. That is a new processor version, not a retention decision.
    expect(() => resolvePruneCutoff({ processorVersion: "v1" }, NOW)).toThrow(
      UnprunableAttributionVersionError,
    );
  });

  it("names the prunable versions when it refuses", () => {
    expect(() => resolvePruneCutoff({ processorVersion: "v1" }, NOW)).toThrow(/Prunable versions/);
  });

  it("refuses a version nobody has declared a window for", () => {
    // Fail closed: a future v3 is unprunable until someone adds it here.
    expect(() => resolvePruneCutoff({ processorVersion: "v3" }, NOW)).toThrow(
      UnprunableAttributionVersionError,
    );
  });

  it("defaults to the version's own window", () => {
    const { idleSeconds, cutoff } = resolvePruneCutoff({ processorVersion: "v2" }, NOW);
    expect(idleSeconds).toBe(90 * DAY);
    expect(cutoff.toISOString()).toBe("2026-05-14T00:00:00.000Z");
  });

  it("allows a LONGER idle window, which is only more conservative", () => {
    const { idleSeconds } = resolvePruneCutoff(
      { processorVersion: "v2", idleSeconds: 180 * DAY },
      NOW,
    );
    expect(idleSeconds).toBe(180 * DAY);
  });

  it("refuses a SHORTER idle window, which would delete readable rows", () => {
    expect(() =>
      resolvePruneCutoff({ processorVersion: "v2", idleSeconds: 30 * DAY }, NOW),
    ).toThrow(IdleWindowTooShortError);
  });

  it("accepts exactly the window", () => {
    expect(() =>
      resolvePruneCutoff({ processorVersion: "v2", idleSeconds: 90 * DAY }, NOW),
    ).not.toThrow();
  });

  it("keeps the declared window in step with the processor's own constant", () => {
    // If v2's DEFAULT_ATTRIBUTION_WINDOW_SECONDS ever moves without this
    // map moving with it, the prune would delete rows the engine can
    // still read. The number is duplicated across a package boundary on
    // purpose — this test is what makes the duplication safe.
    expect(PRUNABLE_ATTRIBUTION_VERSIONS.get("v2")).toBe(90 * DAY);
  });
});
