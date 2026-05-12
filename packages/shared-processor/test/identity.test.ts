/**
 * Tests for `processorLogContext`.
 *
 * Pins the field names and the optional-field omission behaviour so
 * processors that bind these via `logger.child(...)` get a stable shape.
 */
import { describe, expect, it } from "vitest";

import { processorLogContext } from "../src/identity.js";

describe("processorLogContext", () => {
  it("returns the immutable identity fields with stable names", () => {
    const ctx = processorLogContext({
      identity: { name: "analytics-projector", version: "v1" },
    });
    expect(ctx).toEqual({
      processor_name: "analytics-projector",
      processor_version: "v1",
    });
  });

  it("attaches optional fields when present", () => {
    const ctx = processorLogContext({
      identity: { name: "geoip-enricher", version: "v2" },
      run_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f552",
      topic: "raw.events",
      partition: 5,
    });
    expect(ctx).toEqual({
      processor_name: "geoip-enricher",
      processor_version: "v2",
      processor_run_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f552",
      topic: "raw.events",
      partition: 5,
    });
  });

  it("omits run_id / topic / partition when undefined (exactOptionalPropertyTypes-safe)", () => {
    const ctx = processorLogContext({
      identity: { name: "analytics-projector", version: "v1" },
    });
    expect(ctx).not.toHaveProperty("processor_run_id");
    expect(ctx).not.toHaveProperty("topic");
    expect(ctx).not.toHaveProperty("partition");
  });
});
