/**
 * The carve-out changed no emitted byte.
 *
 * `libs/identity/*` and `libs/profiles` were cut out of this stage's
 * `src/`, and the one thing that could not be allowed to move with them
 * is the OUTPUT. `resolver/v1` replay output is a correctness contract —
 * unmerge is repaired by replaying the window through this stage, so a
 * post-carve replay that produced different `identified.events` than the
 * pre-carve one would silently rewrite the profile plane it was supposed
 * to reconstruct.
 *
 * The comparison is against `test/golden/*.output.json`, which is the
 * PRE-CARVE recording: those files were committed by an earlier card,
 * were not regenerated here, and this suite refuses to regenerate them.
 * Running the fixture streams through today's code and diffing the
 * serialised result is therefore exactly "pre-carve resolver vs
 * post-carve resolver on the same input".
 *
 * `golden.test.ts` next door asserts the same fixtures with `toEqual`,
 * which is a STRUCTURAL comparison — it passes on two objects whose keys
 * are in different orders. This one serialises both sides and compares
 * the strings, so key order counts too. That matters because the
 * envelope reaches ClickHouse as JSON and `analytics_raw` dedupes rows
 * by content: a reordered envelope is a different row.
 *
 * The two-space serialisation on both sides is the only normalisation.
 * It exists so the fixture's file formatting is not what the test is
 * about; every byte inside the structure still has to match.
 *
 * Nothing here writes a fixture, and nothing here may learn to. A
 * determinism check that regenerates its own baseline passes forever and
 * proves nothing.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sharedOnlyIsolationLookup } from "@polaris/bus";
import type { IdentityPolicy } from "@polaris/identity-rules";
import { describe, expect, it } from "vitest";

import { handleEvent } from "../src/runtime.js";
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

const SCENARIOS = [
  "creates-profile-for-anonymous-only",
  "binds-customer-to-existing-profile",
  "no-strong-identifier-passes-through",
] as const;

/** Deterministic profile ids, matching how the fixtures were recorded. */
function fixtureIdFactory(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `019ffe00-0000-7000-8000-0000000f${String(n).padStart(4, "0")}`;
  };
}

interface RecordedPublish {
  family: string;
  // Explicitly `| undefined`: `exactOptionalPropertyTypes` is on, and the
  // recorder's `partitionKey` is optional in exactly that sense.
  partition_key?: string | undefined;
  event: Record<string, unknown>;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Run one fixture stream through today's stage. */
async function replay(name: string): Promise<RecordedPublish[]> {
  const input = readJson(resolve(GOLDEN, `${name}.input.json`));
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
  return producer.published.map((published) => ({
    family: published.family,
    partition_key: published.partitionKey,
    event: published.event,
  }));
}

function spineOnly(published: readonly RecordedPublish[]): RecordedPublish[] {
  return published.filter((entry) => entry.family === "identified.events");
}

function serialise(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

describe("post-carve determinism", () => {
  for (const name of SCENARIOS) {
    it(`${name} emits byte-identical identified.events`, async () => {
      const recorded = readJson(resolve(GOLDEN, `${name}.output.json`)) as RecordedPublish[];
      const actual = await replay(name);

      expect(serialise(spineOnly(actual))).toBe(serialise(spineOnly(recorded)));
    });

    it(`${name} emits byte-identical derived facts`, async () => {
      // Not an acceptance criterion, and asserted anyway: `identity.*` and
      // `profile.updated` carry deterministic ids derived from the source
      // event, so a change here would break ClickHouse's collapse of a
      // replayed fact against the original just as surely.
      const recorded = readJson(resolve(GOLDEN, `${name}.output.json`)) as RecordedPublish[];
      const actual = await replay(name);

      expect(serialise(actual)).toBe(serialise(recorded));
    });
  }
});
