/**
 * Golden-fixture tests.
 *
 * The fixtures are GENERATED from this same code path, which sounds
 * circular but is not: their value is that a future change which alters
 * emitted output fails here loudly, forcing whoever made it to look at a
 * concrete before/after diff and decide whether it needs a new processor
 * version. That is the semantic-immutability rule with teeth.
 *
 * The manifest declares these same four files, so `validateProcessorFixtures`
 * and this suite cover each other: the manifest proves they exist, this
 * proves they still describe what the code does.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sharedOnlyIsolationLookup } from "@polaris/shared-transport";
import { describe, expect, it } from "vitest";

import { handleEvent } from "../src/runtime.js";
import { RecordingProducer, silentLogger } from "./fakes.js";
import { FIXTURE_LOOKUP, fixtureReader, GOLDEN_SCENARIOS as SCENARIOS } from "./fixtures.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = resolve(HERE, "golden");
const NOW = new Date("2026-08-14T00:00:00.000Z");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("golden fixtures", () => {
  for (const [name, maxTraitsBytes] of SCENARIOS) {
    it(`${name} reproduces its recorded output`, async () => {
      const input = readJson(resolve(GOLDEN, `${name}.input.json`));
      const expected = readJson(resolve(GOLDEN, `${name}.output.json`));
      const events = Array.isArray(input) ? input : [input];

      const producer = new RecordingProducer();
      const deps = {
        reader: fixtureReader(),
        producer,
        isolation: sharedOnlyIsolationLookup,
        lookup: FIXTURE_LOOKUP,
        logger: silentLogger,
        policyFor: () => ({ maxTraitsBytes }),
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

  it("carries the source event's identity through unchanged in every fixture", () => {
    // The property that makes the three spine families three sightings
    // of one fact rather than three facts.
    for (const [name] of SCENARIOS) {
      const input = readJson(resolve(GOLDEN, `${name}.input.json`)) as Record<string, unknown>;
      const output = readJson(resolve(GOLDEN, `${name}.output.json`)) as Array<{
        event: Record<string, unknown>;
      }>;
      expect(output[0]?.event["event_id"], name).toBe(input["event_id"]);
      expect(output[0]?.event["ingested_at"], name).toBe(input["ingested_at"]);
    }
  });

  it("never records a raw IP address in any fixture output", () => {
    for (const [name] of SCENARIOS) {
      const raw = readFileSync(resolve(GOLDEN, `${name}.output.json`), "utf8");
      const enrichmentBlocks = (JSON.parse(raw) as Array<{ event: Record<string, unknown> }>).map(
        (p) => JSON.stringify(p.event["enrichment"]),
      );
      for (const block of enrichmentBlocks) {
        expect(block, name).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/u);
      }
    }
  });
});
