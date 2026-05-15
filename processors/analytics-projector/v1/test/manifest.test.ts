/**
 * P8-006: cross-processor manifest validation for analytics-projector v1.
 *
 * Loads the on-disk `processor.manifest.yaml` and asserts the field set
 * that every released v1 processor MUST carry:
 *
 *   - name, version, owner match the directory layout
 *   - release_status is set (P8-006's lifecycle flag)
 *   - mode is "streaming"
 *   - inputs / outputs declare expected topic families
 *   - replay metadata exists
 *   - golden fixtures are declared and resolve on disk
 *
 * The cross-processor schema validation is covered by
 * `packages/shared-processor/test/manifest.test.ts`; this test asserts
 * the values specific to analytics-projector v1, so a future drift (e.g.
 * accidentally renaming the output topic family in the manifest) fails
 * fast at this boundary instead of silently.
 *
 * @see docs/development/processor-manifests.md
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadProcessorManifest, validateProcessorFixtures } from "@polaris/shared-processor";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
// `test/manifest.test.ts` → `<processor v1 root>` is three levels up.
const PROCESSOR_DIR = resolve(dirname(__filename), "..");
// Repo root is two levels above the processor's v1 dir
// (processors/<name>/v1 → repo root).
const REPO_ROOT = resolve(PROCESSOR_DIR, "..", "..", "..");

describe("analytics-projector v1 manifest", () => {
  const loaded = loadProcessorManifest({
    root: REPO_ROOT,
    name: "analytics-projector",
    version: "v1",
  });

  it("carries the expected identity fields", () => {
    expect(loaded.manifest.name).toBe("analytics-projector");
    expect(loaded.manifest.version).toBe("v1");
    expect(loaded.manifest.owner).toBe("platform-data");
  });

  it("declares release_status = released (P8-006)", () => {
    expect(loaded.manifest.release_status).toBe("released");
  });

  it("declares mode = streaming", () => {
    expect(loaded.manifest.mode).toBe("streaming");
  });

  it("consumes raw.events and emits analytics.events", () => {
    expect(loaded.manifest.inputs).toEqual([{ family: "raw.events", schema_versions: "*" }]);
    expect(loaded.manifest.outputs).toEqual([{ family: "analytics.events", schema_versions: "*" }]);
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
