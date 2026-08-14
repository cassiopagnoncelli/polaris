/**
 * Manifest tests.
 *
 * The manifest is the SEMANTIC definition of this stage, so these assert
 * the things that would silently change meaning if edited: the declared
 * families must match what the runtime actually subscribes to and
 * publishes on, and the semantic parameters must match the defaults the
 * policy module applies. A manifest that drifts from the code is the
 * "decorative manifest" problem the redesign plan calls out.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadProcessorManifest, validateProcessorFixtures } from "@polaris/shared-processor";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { MANIFEST_DEFAULTS } from "../src/policy.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const UNIT_DIR = resolve(HERE, "..");
const REPO_ROOT = resolve(UNIT_DIR, "..", "..", "..", "..");

describe("sync-identity-resolver v1 manifest", () => {
  const loaded = loadProcessorManifest({
    root: REPO_ROOT,
    name: "sync-identity-resolver",
    version: "v1",
  });

  it("is discoverable by (name, version) from the pipeline tree", () => {
    expect(loaded.manifest.name).toBe("sync-identity-resolver");
    expect(loaded.manifest.version).toBe("v1");
    expect(loaded.path).toContain("sync/identity/resolver/v1");
  });

  it("declares the families the runtime actually uses", () => {
    // Drift here is the failure mode where a manifest documents one
    // topology and the code wires another, with nothing to notice.
    expect(loaded.manifest.inputs.map((i) => i.family)).toEqual(["raw.events"]);
    expect(loaded.manifest.outputs.map((o) => o.family)).toEqual([
      "identified.events",
      "identity.events",
      "profile.events",
    ]);
  });

  it("declares every profile-plane table it writes", () => {
    // The card's central claim is "the profile store's only sync-path
    // writer"; the state stores are where that claim is auditable.
    expect(loaded.manifest.state_stores).toEqual([
      "postgres:profiles",
      "postgres:profile_identifiers",
      "postgres:profile_merges",
      "postgres:identity_links",
    ]);
  });

  it("keeps semantic parameters in step with the policy defaults", () => {
    // These live in the manifest precisely because changing them changes
    // emitted events. If the code default and the declared default ever
    // disagree, the declared one is a lie and a replay would not
    // reproduce.
    const raw = parseYaml(readFileSync(loaded.path, "utf8")) as {
      semantic_parameters: Record<string, { default: number; min: number; max: number }>;
    };
    expect(raw.semantic_parameters["max_identifiers_per_kind"]?.default).toBe(
      MANIFEST_DEFAULTS.maxIdentifiersPerKind,
    );
    expect(raw.semantic_parameters["max_merges_per_window"]?.default).toBe(
      MANIFEST_DEFAULTS.maxMergesPerWindow,
    );
    expect(raw.semantic_parameters["merge_window_seconds"]?.default).toBe(
      MANIFEST_DEFAULTS.mergeWindowSeconds,
    );
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

  it("supports replay, which is also the repair path", () => {
    // Replay is how a bad merge is undone — rebuild the project under a
    // corrected denylist rather than invert the operation.
    expect(loaded.manifest.replay?.supported).toBe(true);
    expect(loaded.manifest.replay?.restrictions).toEqual([]);
  });
});
