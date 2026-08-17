/**
 * The provisioner declares what the package says exists.
 *
 * This drifted twice, the same way both times. The script enumerated a
 * list locally instead of asking the package, and:
 *
 *   - a retention rule added to `defaultRetentionDaysForFamily` never
 *     reached the broker (fixed then, with a comment warning about it);
 *   - `rejected.events` was added to the default topology, asserted by
 *     the package's own test, and never declared — because the script
 *     mapped over `CANONICAL_STREAM_FAMILIES`, and the quarantine is
 *     deliberately NOT canonical.
 *
 * Both were invisible in production terms: stream declarations are
 * idempotent but non-reconciling, so nothing complains about a stream
 * that was never created. The quarantine's publish is fail-open on top of
 * that, so the missing stream would have shown up as an empty dashboard.
 */

import { defaultSuperStreams } from "@polaris/shared-transport";
import { describe, expect, it } from "vitest";

import { buildPlan } from "../rabbitmq-provision.mjs";

// Only the fields `defaultSuperStreams` reads. Cast because RabbitmqConfig
// also carries connection settings this call never touches.
const CONFIG = {
  partitions: 3,
  partitionOverrides: { "raw.events": 6, "identified.events": 6, "resolved.events": 6 },
  streamRetentionDays: 90,
} as unknown as Parameters<typeof defaultSuperStreams>[0];

describe("buildPlan", () => {
  it("declares exactly the families the package's default topology names", () => {
    // The load-bearing assertion: the script has no family list of its
    // own, so a family added in the package reaches the broker without
    // anyone remembering this file exists.
    const planned = buildPlan().superStreams.map((spec: { family: string }) => spec.family);
    const expected = defaultSuperStreams(CONFIG).map((spec) => spec.family);

    expect(planned).toEqual(expected);
  });

  it("includes the quarantine, which is not a canonical family", () => {
    // `rejected.events` supports no per-project isolation, so it is
    // absent from CANONICAL_STREAM_FAMILIES on purpose — which is exactly
    // why enumerating that constant was the wrong source.
    const planned = buildPlan().superStreams.map((spec: { family: string }) => spec.family);
    expect(planned).toContain("rejected.events");
  });

  it("takes retention from the package, not from a flat default", () => {
    const byFamily = new Map(
      buildPlan().superStreams.map((spec: { family: string; retentionDays: number }) => [
        spec.family,
        spec.retentionDays,
      ]),
    );

    // Three different answers, none of them the flat 90.
    expect(byFamily.get("raw.events")).toBe(90);
    // Regenerable from raw.events by replaying the identity stage.
    expect(byFamily.get("identified.events")).toBe(7);
    // A governance signal a week old is a dashboard entry, not an incident.
    expect(byFamily.get("rejected.events")).toBe(7);
  });

  it("still applies the operator's width overrides", () => {
    // Partition count is a capacity decision and stays the script's;
    // retention is a durability decision and stays the package's.
    const byFamily = new Map(
      buildPlan().superStreams.map((spec: { family: string; partitions: number }) => [
        spec.family,
        spec.partitions,
      ]),
    );

    expect(byFamily.get("raw.events")).toBe(6);
    expect(byFamily.get("rejected.events")).toBe(3);
  });

  it("leaves the diagnostics stream undeclared", () => {
    // Nothing produces to it. Reserving disk and putting a permanently
    // empty stream on every dashboard teaches operators to ignore idle
    // streams.
    const planned = buildPlan().superStreams.map((spec: { family: string }) => spec.family);
    expect(planned).not.toContain("polaris.diagnostics.events");
  });
});
