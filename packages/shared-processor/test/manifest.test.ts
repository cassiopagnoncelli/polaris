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
  loadProcessorManifest,
  PROCESSOR_RELEASE_STATUSES,
  ProcessorManifestError,
  processorManifestSchema,
  tryLoadProcessorManifest,
  validateProcessorFixtures,
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

  it("accepts the P8-006 release_status values", () => {
    for (const status of PROCESSOR_RELEASE_STATUSES) {
      const result = processorManifestSchema.safeParse({
        name: "analytics-projector",
        version: "v1",
        owner: "owner",
        description: "desc",
        release_status: status,
        mode: "streaming",
        inputs: [{ family: "raw.events", schema_versions: "*" }],
        outputs: [{ family: "analytics.events", schema_versions: "*" }],
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects release_status values outside the closed set", () => {
    const result = processorManifestSchema.safeParse({
      name: "analytics-projector",
      version: "v1",
      owner: "owner",
      description: "desc",
      release_status: "alpha",
      mode: "streaming",
      inputs: [{ family: "raw.events", schema_versions: "*" }],
      outputs: [{ family: "analytics.events", schema_versions: "*" }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a fixtures block with input/output pairs", () => {
    const result = processorManifestSchema.safeParse({
      name: "analytics-projector",
      version: "v1",
      owner: "owner",
      description: "desc",
      mode: "streaming",
      inputs: [{ family: "raw.events", schema_versions: "*" }],
      outputs: [{ family: "analytics.events", schema_versions: "*" }],
      fixtures: [
        {
          name: "payment-approved",
          input: "test/golden/payment-approved.input.json",
          output: "test/golden/payment-approved.output.json",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects fixture entries with unknown extra keys", () => {
    const result = processorManifestSchema.safeParse({
      name: "analytics-projector",
      version: "v1",
      owner: "owner",
      description: "desc",
      mode: "streaming",
      inputs: [{ family: "raw.events", schema_versions: "*" }],
      outputs: [{ family: "analytics.events", schema_versions: "*" }],
      fixtures: [
        {
          name: "payment-approved",
          input: "test/golden/payment-approved.input.json",
          output: "test/golden/payment-approved.output.json",
          unexpected_key: true,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts the replay_notes free-form string", () => {
    const result = processorManifestSchema.safeParse({
      name: "analytics-projector",
      version: "v1",
      owner: "owner",
      description: "desc",
      mode: "streaming",
      inputs: [{ family: "raw.events", schema_versions: "*" }],
      outputs: [{ family: "analytics.events", schema_versions: "*" }],
      replay_notes:
        "Deterministic passthrough; replaying the same raw.events slice yields the same analytics.events output byte-for-byte.",
    });
    expect(result.success).toBe(true);
  });
});

describe("validateProcessorFixtures", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "polaris-fixture-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeFixture(relativeFromRoot: string, contents: unknown): void {
    const absolute = join(root, relativeFromRoot);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, JSON.stringify(contents, null, 2), "utf8");
  }

  it("resolves fixture paths relative to the manifest file and reports no issues when files parse", () => {
    const manifestPath = join(root, "processors", "demo", "v1", "processor.manifest.yaml");
    mkdirSync(join(manifestPath, ".."), { recursive: true });
    writeFileSync(manifestPath, "# placeholder", "utf8");
    writeFixture("processors/demo/v1/test/golden/case.input.json", { ok: true });
    writeFixture("processors/demo/v1/test/golden/case.output.json", { ok: true });

    const result = validateProcessorFixtures({
      manifestPath,
      manifest: {
        fixtures: [
          {
            name: "case",
            input: "test/golden/case.input.json",
            output: "test/golden/case.output.json",
          },
        ],
      },
    });

    expect(result.issues).toEqual([]);
    expect(result.resolvedPaths).toHaveLength(2);
    expect(result.resolvedPaths[0]).toContain("case.input.json");
    expect(result.resolvedPaths[1]).toContain("case.output.json");
  });

  it("reports a structured issue when the input file is missing", () => {
    const manifestPath = join(root, "processors", "demo", "v1", "processor.manifest.yaml");
    mkdirSync(join(manifestPath, ".."), { recursive: true });
    writeFileSync(manifestPath, "# placeholder", "utf8");
    writeFixture("processors/demo/v1/test/golden/case.output.json", { ok: true });

    const result = validateProcessorFixtures({
      manifestPath,
      manifest: {
        fixtures: [
          {
            name: "case",
            input: "test/golden/case.input.json",
            output: "test/golden/case.output.json",
          },
        ],
      },
    });

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.fixture).toBe("case");
    expect(result.issues[0]?.reason).toMatch(/input file does not exist/);
  });

  it("reports a structured issue when the JSON does not parse", () => {
    const manifestPath = join(root, "processors", "demo", "v1", "processor.manifest.yaml");
    mkdirSync(join(manifestPath, ".."), { recursive: true });
    writeFileSync(manifestPath, "# placeholder", "utf8");
    mkdirSync(join(root, "processors", "demo", "v1", "test", "golden"), { recursive: true });
    writeFileSync(
      join(root, "processors", "demo", "v1", "test", "golden", "case.input.json"),
      "{ not valid",
      "utf8",
    );
    writeFixture("processors/demo/v1/test/golden/case.output.json", { ok: true });

    const result = validateProcessorFixtures({
      manifestPath,
      manifest: {
        fixtures: [
          {
            name: "case",
            input: "test/golden/case.input.json",
            output: "test/golden/case.output.json",
          },
        ],
      },
    });

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.reason).toMatch(/not valid JSON/);
  });

  it("flags duplicate fixture names", () => {
    const manifestPath = join(root, "processors", "demo", "v1", "processor.manifest.yaml");
    mkdirSync(join(manifestPath, ".."), { recursive: true });
    writeFileSync(manifestPath, "# placeholder", "utf8");
    writeFixture("processors/demo/v1/test/golden/case.input.json", { ok: true });
    writeFixture("processors/demo/v1/test/golden/case.output.json", { ok: true });

    const result = validateProcessorFixtures({
      manifestPath,
      manifest: {
        fixtures: [
          {
            name: "case",
            input: "test/golden/case.input.json",
            output: "test/golden/case.output.json",
          },
          {
            name: "case",
            input: "test/golden/case.input.json",
            output: "test/golden/case.output.json",
          },
        ],
      },
    });

    expect(result.issues.some((i) => i.reason.includes("duplicate fixture name"))).toBe(true);
  });

  it("returns an empty result when the manifest has no fixtures block", () => {
    const manifestPath = join(root, "processors", "demo", "v1", "processor.manifest.yaml");
    mkdirSync(join(manifestPath, ".."), { recursive: true });
    writeFileSync(manifestPath, "# placeholder", "utf8");

    const result = validateProcessorFixtures({ manifestPath, manifest: {} });
    expect(result.issues).toEqual([]);
    expect(result.resolvedPaths).toEqual([]);
  });
});
