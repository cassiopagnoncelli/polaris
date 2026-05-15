/**
 * P8-006: cross-processor manifest validation for sessionizer v1.
 *
 * Loads the on-disk `processor.manifest.yaml` and asserts the field set
 * that every released v1 processor MUST carry. See
 * `docs/development/processor-manifests.md`.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadProcessorManifest, validateProcessorFixtures } from "@polaris/shared-processor";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const PROCESSOR_DIR = resolve(dirname(__filename), "..");
const REPO_ROOT = resolve(PROCESSOR_DIR, "..", "..", "..");

describe("sessionizer v1 manifest", () => {
  const loaded = loadProcessorManifest({
    root: REPO_ROOT,
    name: "sessionizer",
    version: "v1",
  });

  it("carries the expected identity fields", () => {
    expect(loaded.manifest.name).toBe("sessionizer");
    expect(loaded.manifest.version).toBe("v1");
    expect(loaded.manifest.owner).toBe("platform-data");
  });

  it("declares release_status = released (P8-006)", () => {
    expect(loaded.manifest.release_status).toBe("released");
  });

  it("declares mode = streaming", () => {
    expect(loaded.manifest.mode).toBe("streaming");
  });

  it("consumes raw.events and emits session.events", () => {
    expect(loaded.manifest.inputs).toEqual([{ family: "raw.events", schema_versions: "*" }]);
    expect(loaded.manifest.outputs).toEqual([{ family: "session.events", schema_versions: [1] }]);
  });

  it("declares the in-memory sessions state store", () => {
    expect(loaded.manifest.state_stores).toContain("memory:sessions");
  });

  it("declares the semantic inactivity window in defaults", () => {
    // 30 min per the Web SDK rotation rule. The value is SEMANTIC and
    // changing it requires bumping the processor to v2.
    expect(loaded.manifest.defaults?.session_inactivity_seconds).toBe(1800);
  });

  it("declares replay metadata", () => {
    expect(loaded.manifest.replay?.supported).toBe(true);
    expect(loaded.manifest.replay_notes).toBeDefined();
    expect((loaded.manifest.replay_notes ?? "").length).toBeGreaterThan(0);
  });

  it("declares at least one golden fixture pair and the files resolve on disk", () => {
    expect(loaded.manifest.fixtures).toBeDefined();
    expect((loaded.manifest.fixtures ?? []).length).toBeGreaterThan(0);
    const validation = validateProcessorFixtures({
      manifestPath: loaded.path,
      manifest: loaded.manifest,
    });
    expect(validation.issues).toEqual([]);
    expect(validation.resolvedPaths.length).toBe((loaded.manifest.fixtures ?? []).length * 2);
  });
});
