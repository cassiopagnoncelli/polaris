/**
 * Tests for the processor manifest loader.
 *
 * Uses a temp directory layout mimicking the on-disk
 * `processors/<name>/<version>/processor.manifest.yaml` convention.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ProcessorManifestError,
  loadProcessorManifest,
  tryLoadProcessorManifest,
  processorManifestSchema,
} from "../src/manifest.js";

const VALID_YAML = `
name: analytics-projector
version: v1
owner: platform-data
description: |
  Test manifest used by the manifest loader unit tests.
mode: streaming
inputs:
  - family: raw.events
    schema_versions: "*"
outputs:
  - family: analytics.events
    schema_versions: "*"
state_stores: []
defaults:
  consumer_group: polaris-analytics-projector-v1
  partitions_consumed_concurrently: 1
replay:
  supported: true
  restrictions: []
`;

describe("loadProcessorManifest", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "polaris-manifest-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeManifest(name: string, version: string, content: string): void {
    const dir = join(root, "processors", name, version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "processor.manifest.yaml"), content, "utf8");
  }

  it("parses a valid manifest and returns the typed shape + on-disk path", () => {
    writeManifest("analytics-projector", "v1", VALID_YAML);
    const loaded = loadProcessorManifest({
      root,
      name: "analytics-projector",
      version: "v1",
    });
    expect(loaded.path).toContain("processors/analytics-projector/v1/processor.manifest.yaml");
    expect(loaded.manifest.name).toBe("analytics-projector");
    expect(loaded.manifest.version).toBe("v1");
    expect(loaded.manifest.mode).toBe("streaming");
    expect(loaded.manifest.inputs).toEqual([{ family: "raw.events", schema_versions: "*" }]);
    expect(loaded.manifest.outputs).toEqual([{ family: "analytics.events", schema_versions: "*" }]);
    expect(loaded.manifest.replay).toEqual({ supported: true, restrictions: [] });
  });

  it("throws ProcessorManifestError when the file does not exist", () => {
    expect(() => loadProcessorManifest({ root, name: "missing", version: "v1" })).toThrow(
      ProcessorManifestError,
    );
  });

  it("throws ProcessorManifestError on malformed YAML", () => {
    writeManifest("analytics-projector", "v1", "name: analytics-projector\n  : :  : :");
    expect(() =>
      loadProcessorManifest({
        root,
        name: "analytics-projector",
        version: "v1",
      }),
    ).toThrow(ProcessorManifestError);
  });

  it("throws ProcessorManifestError on schema validation failure", () => {
    writeManifest("analytics-projector", "v1", "name: analytics-projector\nversion: vX");
    expect(() =>
      loadProcessorManifest({
        root,
        name: "analytics-projector",
        version: "v1",
      }),
    ).toThrow(ProcessorManifestError);
  });

  it("rejects unknown top-level keys", () => {
    const yamlWithExtra = `${VALID_YAML}\nextra_unknown: 42\n`;
    writeManifest("analytics-projector", "v1", yamlWithExtra);
    expect(() =>
      loadProcessorManifest({
        root,
        name: "analytics-projector",
        version: "v1",
      }),
    ).toThrow(/extra_unknown|Unrecognized/);
  });
});

describe("tryLoadProcessorManifest", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "polaris-manifest-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns ok=true with the typed value on success", () => {
    const dir = join(root, "processors", "analytics-projector", "v1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "processor.manifest.yaml"), VALID_YAML, "utf8");
    const result = tryLoadProcessorManifest({
      root,
      name: "analytics-projector",
      version: "v1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.value.manifest.name).toBe("analytics-projector");
  });

  it("returns ok=false with a structured reason on missing file", () => {
    const result = tryLoadProcessorManifest({
      root,
      name: "missing",
      version: "v1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.reason).toContain("no manifest at");
    expect(result.path).toContain("processors/missing/v1/processor.manifest.yaml");
  });
});

describe("processorManifestSchema", () => {
  it("rejects mode values outside the closed set", () => {
    const result = processorManifestSchema.safeParse({
      name: "x",
      version: "v1",
      owner: "owner",
      description: "desc",
      mode: "weird",
      inputs: [{ family: "raw.events", schema_versions: "*" }],
      outputs: [{ family: "analytics.events", schema_versions: "*" }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts explicit schema_versions lists", () => {
    const result = processorManifestSchema.safeParse({
      name: "analytics-projector",
      version: "v1",
      owner: "owner",
      description: "desc",
      mode: "streaming",
      inputs: [{ family: "raw.events", schema_versions: [1, 2] }],
      outputs: [{ family: "analytics.events", schema_versions: "*" }],
    });
    expect(result.success).toBe(true);
  });
});
