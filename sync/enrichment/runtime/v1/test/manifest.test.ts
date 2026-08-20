/**
 * Manifest tests.
 *
 * The manifest is the semantic definition of this stage, so these assert
 * the things that would silently change meaning if edited: the declared
 * families must match what the runtime subscribes to and publishes on,
 * the semantic parameter must match the code default, and — the reason
 * this suite matters more here than next door — the composed-unit pins
 * must match both the runtime's constant AND the enricher packages
 * themselves.
 *
 * That last check is the one the destination idiom lacks. Destinations
 * restate their sub-unit versions in a YAML nothing parses, so the YAML
 * and the TypeScript can disagree silently while the YAML is what an
 * auditor reads. Three statements of one fact, checked against each
 * other, cost one test.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadProcessorManifest, validateProcessorFixtures } from "@polaris/pipeline";
import { ENRICHER_IDENTITY as GEOIP_IDENTITY } from "@polaris/sync-enrichment-geoip-v1";
import { ENRICHER_IDENTITY as TRAITS_IDENTITY } from "@polaris/sync-enrichment-traits-v1";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { ENRICHER_PINS } from "../src/pins.js";
import { MANIFEST_DEFAULTS } from "../src/policy.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const UNIT_DIR = resolve(HERE, "..");
const REPO_ROOT = resolve(UNIT_DIR, "..", "..", "..", "..");

describe("sync-enrichment-runtime v1 manifest", () => {
  const loaded = loadProcessorManifest({
    root: REPO_ROOT,
    name: "sync-enrichment-runtime",
    version: "v1",
  });

  it("is discoverable by (name, version) from the pipeline tree", () => {
    expect(loaded.manifest.name).toBe("sync-enrichment-runtime");
    expect(loaded.manifest.version).toBe("v1");
    expect(loaded.path).toContain("sync/enrichment/runtime/v1");
  });

  it("declares the families the runtime actually uses", () => {
    expect(loaded.manifest.inputs.map((i) => i.family)).toEqual(["identified.events"]);
    expect(loaded.manifest.outputs.map((o) => o.family)).toEqual(["resolved.events"]);
  });

  it("declares the profile store it reads, and nothing it does not touch", () => {
    // The asymmetry with the identity stage's four entries is the
    // ownership line made auditable: this stage names one table and
    // holds no writer for it.
    expect(loaded.manifest.state_stores).toEqual(["postgres:profiles"]);
  });

  it("pins the enricher versions the runtime composes", () => {
    expect(loaded.manifest.composes).toEqual([...ENRICHER_PINS]);
  });

  it("pins versions the enricher packages actually declare", () => {
    // The half a restated-YAML pin cannot catch: a manifest that agrees
    // with the runtime constant and both disagree with the unit.
    const declared = new Map(
      (loaded.manifest.composes ?? []).map((unit) => [unit.name, unit.version]),
    );
    expect(declared.get(TRAITS_IDENTITY.name)).toBe(TRAITS_IDENTITY.version);
    expect(declared.get(GEOIP_IDENTITY.name)).toBe(GEOIP_IDENTITY.version);
    expect(declared.size).toBe(2);
  });

  it("keeps the semantic parameter in step with the policy default", () => {
    const raw = parseYaml(readFileSync(loaded.path, "utf8")) as {
      semantic_parameters: Record<string, { default: number; min: number; max: number }>;
    };
    expect(raw.semantic_parameters["max_traits_bytes"]?.default).toBe(
      MANIFEST_DEFAULTS.maxTraitsBytes,
    );
  });

  it("declares golden fixtures whose files exist on disk", () => {
    const validation = validateProcessorFixtures({
      manifest: loaded.manifest,
      manifestPath: loaded.path,
    });
    expect(validation.issues).toEqual([]);
    expect(validation.resolvedPaths.length).toBe((loaded.manifest.fixtures ?? []).length * 2);
  });

  it("supports replay, and states what a replay does NOT reproduce", () => {
    // Enrichment reads state at run time, so a replay is not a
    // historical reconstruction. Saying so in the manifest is what stops
    // someone using it as one.
    expect(loaded.manifest.replay?.supported).toBe(true);
    expect(loaded.manifest.replay?.restrictions?.length).toBeGreaterThan(0);
  });
});
