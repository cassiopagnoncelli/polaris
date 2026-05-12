/**
 * Zod schemas, types, and filesystem loader for processor manifests.
 *
 * Manifests live next to processor code under
 * `processors/<name>/v<n>/processor.manifest.yaml` and are the SEMANTIC
 * definition of each processor version. The CLI reads them for `processors
 * list` and `processors show`; it must NEVER write to them. P6-005 is also
 * not allowed to touch `processors/*\/v*\/src/` — that's owned by the
 * processor task cards (P4-001, P8-*).
 *
 * Schema mirrors the manifest produced by P4-001
 * (`processors/analytics-projector/v1/processor.manifest.yaml`):
 *
 *   name: analytics-projector
 *   version: v1
 *   owner: platform-data
 *   description: "..."
 *   mode: streaming
 *   inputs:
 *     - family: raw.events
 *       schema_versions: "*"
 *   outputs:
 *     - family: analytics.events
 *       schema_versions: "*"
 *   state_stores: []
 *   defaults:
 *     consumer_group: polaris-analytics-projector-v1
 *     partitions_consumed_concurrently: 1
 *   replay:
 *     supported: true
 *     restrictions: []
 *
 * See:
 *   - docs/architecture/05-processors-and-replay.md
 *   - processors/analytics-projector/v1/processor.manifest.yaml
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * Closed set of processor modes. `streaming` maps one input event to one
 * emitted event; `batch` aggregates multiple inputs into one output. The
 * mode is part of the semantic definition and changing it requires a new
 * processor version.
 */
export const PROCESSOR_MODES = ["streaming", "batch"] as const;
export const processorModeSchema = z.enum(PROCESSOR_MODES);
export type ProcessorMode = z.infer<typeof processorModeSchema>;

/**
 * Version-string pattern. `v1`, `v2`, `v1.2.3` all valid. Mirrors the
 * `processor_activations_processor_version_format` CHECK constraint.
 */
export const processorVersionSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^v[0-9]+(\.[0-9]+){0,2}$/, {
    message: "must be a semver-like tag prefixed with 'v', e.g. v1 or v1.2.3",
  });

/**
 * Processor catalog name. Mirrors the
 * `processor_activations_processor_name_format` CHECK constraint and the
 * directory naming convention under `processors/`.
 */
export const processorNameSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]{1,62}[a-z0-9]$/, {
    message: "must be lowercase, alphanumerics + `_-`, 3-64 chars",
  });

/**
 * Topic family + accepted schema versions an input/output declares. The
 * runtime resolver (P8-001) turns the family into concrete topic names per
 * project isolation state.
 */
export const processorTopicSpecSchema = z
  .object({
    family: z.string().min(1).max(128),
    // Either the literal "*" (passthrough) or a list of explicit integer
    // versions. The manifest YAML for analytics-projector uses "*".
    schema_versions: z.union([z.literal("*"), z.array(z.number().int().positive())]),
  })
  .strict();
export type ProcessorTopicSpec = z.infer<typeof processorTopicSpecSchema>;

/**
 * Replay metadata block. Mirrors the manifest in
 * `processors/analytics-projector/v1/processor.manifest.yaml`.
 */
export const processorReplaySchema = z
  .object({
    supported: z.boolean(),
    restrictions: z.array(z.string()).default([]),
  })
  .strict();
export type ProcessorReplay = z.infer<typeof processorReplaySchema>;

/**
 * Operational defaults the runtime helpers fall back to when no activation
 * row overrides them. These are non-semantic per the architecture doc
 * ("Processor Configuration").
 *
 * The shape is intentionally `.passthrough()` so future processors can
 * declare additional non-semantic defaults (max_concurrency, batch_size,
 * ...) without bumping this schema. The Zod parse still records the known
 * fields with their types.
 */
export const processorDefaultsSchema = z
  .object({
    consumer_group: z.string().min(1).max(128).optional(),
    partitions_consumed_concurrently: z.number().int().positive().optional(),
  })
  .passthrough();
export type ProcessorDefaults = z.infer<typeof processorDefaultsSchema>;

/**
 * Shape of `processors/<name>/v<n>/processor.manifest.yaml`.
 *
 * NOTE: this schema rejects unknown top-level keys via `.strict()`. New
 * fields land here as the architecture grows; for now we mirror what
 * P4-001 ships.
 */
export const processorManifestSchema = z
  .object({
    name: processorNameSchema,
    version: processorVersionSchema,
    owner: z.string().trim().min(1).max(128),
    description: z.string().trim().min(1).max(8192),
    mode: processorModeSchema,
    inputs: z.array(processorTopicSpecSchema).min(1),
    outputs: z.array(processorTopicSpecSchema).min(1),
    state_stores: z.array(z.string()).default([]),
    defaults: processorDefaultsSchema.optional(),
    replay: processorReplaySchema.optional(),
  })
  .strict();
export type ProcessorManifest = z.infer<typeof processorManifestSchema>;

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
 * Result of walking `processors/<name>/v<n>/processor.manifest.yaml` files.
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
  /** Repository root. The loader resolves `processors/` underneath. */
  readonly root: string;
}

/**
 * Walk `<root>/processors/<name>/v<n>/processor.manifest.yaml`, parse and
 * validate each one. Returns `(manifests, warnings)` — malformed files
 * surface as warnings, not exceptions, so `processors list` keeps working
 * after one bad manifest lands.
 */
export function loadProcessorManifests(
  options: LoadProcessorManifestsOptions,
): ProcessorManifestScan {
  const processorsDir = join(options.root, "processors");
  if (!existsAsDir(processorsDir)) {
    return { manifests: [], warnings: [] };
  }

  const manifests: DiscoveredProcessorManifest[] = [];
  const warnings: ProcessorManifestWarning[] = [];

  for (const nameEntry of readdirSync(processorsDir).sort()) {
    if (nameEntry.startsWith(".")) continue;
    const nameDir = join(processorsDir, nameEntry);
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
  const manifestPath = join(
    options.root,
    "processors",
    options.name,
    options.version,
    "processor.manifest.yaml",
  );
  if (!existsAsFile(manifestPath)) {
    return {
      ok: false,
      reason: `no manifest at ${manifestPath} — check the (name, version) pair against the on-disk processors/ tree`,
    };
  }
  const parsed = readAndParseManifest(manifestPath);
  if (parsed.ok) {
    return { ok: true, value: { path: manifestPath, manifest: parsed.value } };
  }
  return { ok: false, reason: parsed.reason };
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
