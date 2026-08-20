/**
 * Filesystem loader for processor manifests.
 *
 * Manifests live next to processor code at
 * `{sync,async}/<stage>/<name>/<version>/processor.manifest.yaml` and are
 * the SEMANTIC definition of each processor version. The CLI reads them
 * for `processors list` / `processors show`; it must NEVER write to them.
 *
 * ## The schema is imported, not restated
 *
 * This module used to fork the manifest schema, on the reasoning that the
 * CLI is read-only and should validate whatever is on disk. The fork did
 * what forks do: `semantic_parameters` was added to the canonical schema
 * and the CLI silently began reporting every manifest carrying it as
 * "malformed", skipping it from `processors list` — a warning on stderr
 * standing in for the one processor an operator most wanted to see.
 *
 * A read-only reader has no license to disagree with the writer about
 * what a valid manifest is. The schema now comes from
 * `@polaris/shared-processor`, which is where the manifest contract
 * lives; what stays here is the part that is genuinely CLI-shaped — the
 * tree walk, and the decision to warn-and-continue rather than throw so
 * one bad file cannot break `processors list`.
 *
 * See:
 *   - docs/architecture/05-processors-and-replay.md
 *   - libs/pipeline/src/manifest.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  PROCESSOR_MODES,
  PROCESSOR_RELEASE_STATUSES,
  type ProcessorDefaults,
  type ProcessorFixture,
  type ProcessorManifest,
  type ProcessorMode,
  type ProcessorReleaseStatus,
  type ProcessorReplay,
  type ProcessorTopicSpec,
  processorDefaultsSchema,
  processorFixtureSchema,
  processorManifestSchema,
  processorModeSchema,
  processorNameSchema,
  processorReleaseStatusSchema,
  processorReplaySchema,
  processorTopicSpecSchema,
  processorVersionSchema,
} from "@polaris/shared-processor";
import { parse as parseYaml } from "yaml";

// Re-exported so existing CLI imports keep resolving through this module.
// The definitions are the canonical ones; nothing here redefines them.
export {
  PROCESSOR_MODES,
  PROCESSOR_RELEASE_STATUSES,
  type ProcessorDefaults,
  type ProcessorFixture,
  type ProcessorManifest,
  type ProcessorMode,
  type ProcessorReleaseStatus,
  type ProcessorReplay,
  type ProcessorTopicSpec,
  processorDefaultsSchema,
  processorFixtureSchema,
  processorManifestSchema,
  processorModeSchema,
  processorNameSchema,
  processorReleaseStatusSchema,
  processorReplaySchema,
  processorTopicSpecSchema,
  processorVersionSchema,
};

/**
 * In-memory record of one discovered manifest. Carries the on-disk path so
 * commands can surface where they read it from when explaining a warning.
 */
export interface DiscoveredProcessorManifest {
  /** Absolute path to the manifest file. */
  readonly path: string;
  /** Parsed manifest. */
  readonly manifest: ProcessorManifest;
}

/**
 * A warning emitted by the loader when a manifest is malformed. The CLI
 * surfaces warnings to stderr and continues with the remaining manifests so
 * one bad file does not crash `processors list`.
 */
export interface ProcessorManifestWarning {
  /** Absolute path to the offending manifest. */
  readonly path: string;
  /** Human-readable reason. */
  readonly reason: string;
}

/**
 * Result of walking `{sync,async}/<stage>/<name>/<version>/processor.manifest.yaml`.
 *
 * `manifests` is sorted by `(name, version)` for stable rendering. The
 * loader does NOT throw on a per-manifest parse failure — it appends to
 * `warnings` and continues. The CLI surfaces the warnings via stderr.
 */
export interface ProcessorManifestScan {
  readonly manifests: readonly DiscoveredProcessorManifest[];
  readonly warnings: readonly ProcessorManifestWarning[];
}

export interface LoadProcessorManifestsOptions {
  /** Repository root. The loader resolves the pipeline planes underneath. */
  readonly root: string;
}

/**
 * The two pipeline planes. A stream-attached unit lives at
 * `<plane>/<stage>/<name>/<version>/`, so the tree says which pipeline and
 * which stage owns it — see `docs/implementation/pipeline-redesign-plan.md`
 * §2.3. The loader walks both planes and does not care which stage a
 * manifest turned up under: `(name, version)` remains the identity.
 */
const PIPELINE_PLANES = ["sync", "async"] as const;

/**
 * Walk `<root>/{sync,async}/<stage>/<name>/<version>/processor.manifest.yaml`,
 * parse and validate each one. Returns `(manifests, warnings)` — malformed
 * files surface as warnings, not exceptions, so `processors list` keeps
 * working after one bad manifest lands.
 */
export function loadProcessorManifests(
  options: LoadProcessorManifestsOptions,
): ProcessorManifestScan {
  const manifests: DiscoveredProcessorManifest[] = [];
  const warnings: ProcessorManifestWarning[] = [];

  for (const plane of PIPELINE_PLANES) {
    const planeDir = join(options.root, plane);
    if (!existsAsDir(planeDir)) continue;

    for (const stageEntry of readdirSync(planeDir).sort()) {
      if (stageEntry.startsWith(".")) continue;
      const stageDir = join(planeDir, stageEntry);
      if (!existsAsDir(stageDir)) continue;

      for (const nameEntry of readdirSync(stageDir).sort()) {
        if (nameEntry.startsWith(".")) continue;
        const nameDir = join(stageDir, nameEntry);
        if (!existsAsDir(nameDir)) continue;

        for (const versionEntry of readdirSync(nameDir).sort()) {
          if (versionEntry.startsWith(".")) continue;
          const versionDir = join(nameDir, versionEntry);
          if (!existsAsDir(versionDir)) continue;

          const manifestPath = join(versionDir, "processor.manifest.yaml");
          if (!existsAsFile(manifestPath)) continue;

          const parsed = readAndParseManifest(manifestPath);
          if (parsed.ok) {
            manifests.push({ path: manifestPath, manifest: parsed.value });
          } else {
            warnings.push({ path: manifestPath, reason: parsed.reason });
          }
        }
      }
    }
  }

  manifests.sort((a, b) => {
    if (a.manifest.name !== b.manifest.name) {
      return a.manifest.name.localeCompare(b.manifest.name);
    }
    return a.manifest.version.localeCompare(b.manifest.version);
  });

  return { manifests, warnings };
}

/**
 * Read one manifest by exact `(name, version)`. Returns `null` when the file
 * does not exist or fails validation. Used by `processors show`.
 *
 * On parse failure we return `null` AND the structured reason via the
 * second tuple slot so callers can surface "manifest invalid: ..." rather
 * than a stack trace.
 */
export interface LoadOneProcessorManifestOptions {
  readonly root: string;
  readonly name: string;
  readonly version: string;
}

export function loadProcessorManifest(
  options: LoadOneProcessorManifestOptions,
): { ok: true; value: DiscoveredProcessorManifest } | { ok: false; reason: string } {
  // A processor's path no longer follows from its name: the stage sits
  // between the plane and the name (`{sync,async}/<stage>/<name>/<version>/`),
  // and a unit may move stage without changing identity. So resolve by
  // scanning and matching `(name, version)` from the manifests themselves —
  // the directory name is a convention, the manifest is the truth.
  const scan = loadProcessorManifests({ root: options.root });
  const hit = scan.manifests.find(
    (m) => m.manifest.name === options.name && m.manifest.version === options.version,
  );
  if (hit !== undefined) {
    return { ok: true, value: hit };
  }
  const malformed = scan.warnings.find((w) =>
    w.path.includes(`/${options.name}/${options.version}/`),
  );
  if (malformed !== undefined) {
    return { ok: false, reason: malformed.reason };
  }
  return {
    ok: false,
    reason:
      `no manifest for (${options.name}, ${options.version}) under ` +
      `${options.root}/{sync,async}/ — check the pair against the on-disk pipeline tree`,
  };
}

function readAndParseManifest(
  path: string,
): { ok: true; value: ProcessorManifest } | { ok: false; reason: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, reason: `read failure: ${reason}` };
  }

  let yaml: unknown;
  try {
    yaml = parseYaml(text);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, reason: `YAML parse error: ${reason}` };
  }

  const parsed = processorManifestSchema.safeParse(yaml);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => {
        const where = issue.path.length === 0 ? "<root>" : issue.path.join(".");
        return `${where}: ${issue.message}`;
      })
      .join("; ");
    return { ok: false, reason: `schema validation failed: ${issues}` };
  }
  return { ok: true, value: parsed.data };
}

function existsAsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function existsAsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
