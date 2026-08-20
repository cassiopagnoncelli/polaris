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

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSuperStreams, POLARIS_COMPONENTS } from "@polaris/bus";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

/**
 * A service that dead-letters must have its queues declared.
 *
 * `POLARIS_COMPONENTS` is what `rabbitmq:provision` walks to create
 * `<component>.retry.*`, `.redeliver` and `.dlq`. `archiver` declared
 * `component: "archiver"` and wired the poison path while sitting outside
 * that list, so its DLQ was never created -- and publishing to a missing
 * queue through the default exchange is silently dropped. An empty DLQ
 * reads as "nothing has ever failed", which is the most expensive possible
 * way to be wrong about a dead-letter path.
 *
 * Scanned from source rather than imported: these constants live in service
 * packages, and a test that had to build them all to check a list would be
 * a test people delete.
 */
describe("every service that dead-letters is a declared component", () => {
  it("has a component entry for each `*_COMPONENT` a service declares", () => {
    const declared = new Set<string>();
    const roots = [join(REPO_ROOT, "sync"), join(REPO_ROOT, "async")];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", "dist", "test", "__tests__"].includes(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) {
          for (const m of readFileSync(full, "utf8").matchAll(
            /(?:^|\s)(?:export\s+)?const\s+\w*COMPONENT\s*=\s*"([a-z0-9-]+)"/g,
          )) {
            if (m[1] !== undefined) declared.add(m[1]);
          }
        }
      }
    };
    for (const r of roots) walk(r);

    const missing = [...declared].filter((c) => !POLARIS_COMPONENTS.includes(c as never));
    expect(missing).toEqual([]);
    // Not vacuous: several services declare one.
    expect(declared.size).toBeGreaterThan(3);
  });
});
