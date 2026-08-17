/**
 * Golden-fixture tests.
 *
 * The fixtures are GENERATED from this same code path, which sounds
 * circular but is not: their value is that a future change which alters
 * emitted output fails here loudly, forcing whoever made it to look at a
 * concrete before/after diff and decide whether it needs a new processor
 * version. That is the semantic-immutability rule with teeth.
 *
 * The manifest declares these same three files, so `validateProcessorFixtures`
 * and this suite cover each other: the manifest proves they exist, this
 * proves they still describe what the code does.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sharedOnlyIsolationLookup } from "@polaris/shared-transport";
import { describe, expect, it } from "vitest";

import { handleEvent } from "../src/runtime.js";
import type { IdentityPolicy } from "../src/transform.js";
import { InMemoryProfileRepository, RecordingProducer, silentLogger } from "./fakes.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = resolve(HERE, "golden");

const POLICY: IdentityPolicy = {
  denylist: {},
  maxIdentifiersPerKind: 100,
  maxMergesPerWindow: 50,
  mergeWindowSeconds: 3600,
  maxTraitsBytes: 32768,
};
const NOW = new Date("2026-08-14T00:00:00.000Z");

/** Deterministic profile ids, so fixtures are stable across runs. */
function fixtureIdFactory(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `019ffe00-0000-7000-8000-0000000f${String(n).padStart(4, "0")}`;
  };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

const SCENARIOS = [
  "creates-profile-for-anonymous-only",
  "binds-customer-to-existing-profile",
  "no-strong-identifier-passes-through",
] as const;

describe("golden fixtures", () => {
  for (const name of SCENARIOS) {
    it(`${name} reproduces its recorded output`, async () => {
      const input = readJson(resolve(GOLDEN, `${name}.input.json`));
      const expected = readJson(resolve(GOLDEN, `${name}.output.json`));
      const events = Array.isArray(input) ? input : [input];

      const producer = new RecordingProducer();
      const deps = {
        repository: new InMemoryProfileRepository(fixtureIdFactory()),
        producer,
        isolation: sharedOnlyIsolationLookup,
        logger: silentLogger,
        policyFor: () => POLICY,
        runId: () => "run_fixture",
        now: () => NOW,
      };
      for (const event of events) {
        await handleEvent(deps, event as Record<string, unknown>);
      }

      const actual = producer.published.map((p) => ({
        family: p.family,
        partition_key: p.partitionKey,
        event: p.event,
      }));
      expect(actual).toEqual(expected);
    });
  }

  it("keeps one profile across the login transition", () => {
    // The property the middle fixture exists to record: the pre-login
    // page view and the post-login identify carry the SAME profile id.
    // If a change ever splits them, this fails with the ids in the
    // message rather than a vague diff.
    const output = readJson(
      resolve(GOLDEN, "binds-customer-to-existing-profile.output.json"),
    ) as Array<{ family: string; event: Record<string, unknown> }>;

    const spineProfiles = output
      .filter((p) => p.family === "identified.events")
      .map((p) => (p.event["profile"] as Record<string, unknown>)["profile_id"]);

    expect(spineProfiles).toHaveLength(2);
    expect(spineProfiles[0]).toBe(spineProfiles[1]);
  });

  it("stamps a null profile rather than dropping an unidentifiable event", () => {
    const output = readJson(
      resolve(GOLDEN, "no-strong-identifier-passes-through.output.json"),
    ) as Array<{ family: string; event: Record<string, unknown> }>;

    expect(output).toHaveLength(1);
    expect(output[0]?.family).toBe("identified.events");
    expect(output[0]?.event["profile"]).toBeNull();
  });
});
