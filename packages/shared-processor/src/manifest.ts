/**
 * Processor manifest loader.
 *
 * Manifests live next to processor code under
 * `processors/<name>/v<n>/processor.manifest.yaml`. They are the SEMANTIC
 * definition of each processor version per
 * `docs/architecture/05-processors-and-replay.md`. The CLI (P6-005) reads
 * the same files for `processors list` and `processors show`; the runtime
 * helpers read them on boot so they can route topic-family inputs/outputs,
 * size the consumer group, and expose the manifest in `/health` payloads.
 *
 * The Zod schema mirrors `apps/polaris-cli/src/catalog/processors.ts` so
 * both consumers parse the same on-disk shape. A follow-up task can
 * consolidate the duplication by re-exporting this schema from
 * `@polaris/shared-processor` and having the CLI import it; that change is
 * intentionally out of scope here because the CLI shipped before this
 * package and the consolidation is a cross-cut.
 *
 * The loader rejects unknown top-level keys (`.strict()`) so a typo in a
 * manifest fails at boot rather than silently being ignored.
 */

import { readFileSync, statSync } from "node:fs";
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
 * `processor_activations_processor_version_format` CHECK constraint in
 * `db/migrations/20260512000006_create_processor_activations.sql`.
 */
export const processorVersionSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^v[0-9]+(\.[0-9]+){0,2}$/u, {
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
  .regex(/^[a-z][a-z0-9_-]{1,62}[a-z0-9]$/u, {
    message: "must be lowercase, alphanumerics + `_-`, 3-64 chars",
  });

/**
 * Topic family + accepted schema versions an input/output declares. The
 * runtime resolver in `@polaris/shared-kafka` turns the family into
 * concrete topic names per project isolation state.
 */
export const processorTopicSpecSchema = z
  .object({
    family: z.string().min(1).max(128),
    // Either the literal "*" (passthrough) or a list of explicit integer
    // versions. The analytics-projector manifest uses "*".
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
 * row overrides them. Non-semantic per the architecture doc ("Processor
 * Configuration").
 *
 * Declared as `.passthrough()` so future processors can declare
 * additional non-semantic defaults (max_concurrency, batch_size, ...)
 * without bumping this schema.
 */
export const processorDefaultsSchema = z
  .object({
    consumer_group: z.string().min(1).max(128).optional(),
    partitions_consumed_concurrently: z.number().int().positive().optional(),
  })
  .passthrough();
export type ProcessorDefaults = z.infer<typeof processorDefaultsSchema>;

/**
 * Shape of `processors/<name>/v<n>/processor.manifest.yaml`. Rejects
 * unknown top-level keys via `.strict()`.
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
 * Thrown when a manifest cannot be located or parsed. The runtime treats
 * this as a fatal startup error: if the processor cannot find its
 * manifest, the deployment is misconfigured.
 */
export class ProcessorManifestError extends Error {
  public override readonly name = "ProcessorManifestError";
  public readonly manifestPath: string;
  public readonly reason: string;

  constructor(manifestPath: string, reason: string) {
    super(`processor manifest error at ${manifestPath}: ${reason}`);
    this.manifestPath = manifestPath;
    this.reason = reason;
  }
}

/** Options accepted by `loadProcessorManifest`. */
export interface LoadProcessorManifestOptions {
  /** Repository root. The loader resolves `processors/<name>/<version>/...` underneath. */
  readonly root: string;
  /** Processor name (matches the directory under `processors/`). */
  readonly name: string;
  /** Version label (matches the directory under `processors/<name>/`). */
  readonly version: string;
}

/** Result of loading one manifest by `(name, version)`. */
export interface LoadedProcessorManifest {
  /** Absolute path to the manifest file. */
  readonly path: string;
  /** Parsed and validated manifest. */
  readonly manifest: ProcessorManifest;
}

/**
 * Load one manifest by `(name, version)`. Throws `ProcessorManifestError`
 * on missing file, YAML parse error, or Zod validation failure.
 *
 * The runtime helpers prefer the throwing variant because boot-time
 * failures should be loud. Tools that want to swallow per-manifest errors
 * (e.g. the CLI's `processors list`, which surfaces warnings) call
 * `tryLoadProcessorManifest` instead.
 */
export function loadProcessorManifest(
  options: LoadProcessorManifestOptions,
): LoadedProcessorManifest {
  const result = tryLoadProcessorManifest(options);
  if (result.ok) return result.value;
  throw new ProcessorManifestError(result.path, result.reason);
}

/**
 * Try-variant of `loadProcessorManifest` returning a Result-shaped value.
 * Useful for tools that want to surface multiple manifest warnings rather
 * than crash on the first bad file.
 */
export function tryLoadProcessorManifest(
  options: LoadProcessorManifestOptions,
): { ok: true; value: LoadedProcessorManifest } | { ok: false; path: string; reason: string } {
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
      path: manifestPath,
      reason: `no manifest at ${manifestPath} — check the (name, version) pair against the on-disk processors/ tree`,
    };
  }

  let text: string;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, path: manifestPath, reason: `read failure: ${reason}` };
  }

  let yaml: unknown;
  try {
    yaml = parseYaml(text);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, path: manifestPath, reason: `YAML parse error: ${reason}` };
  }

  const parsed = processorManifestSchema.safeParse(yaml);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => {
        const where = issue.path.length === 0 ? "<root>" : issue.path.join(".");
        return `${where}: ${issue.message}`;
      })
      .join("; ");
    return { ok: false, path: manifestPath, reason: `schema validation failed: ${issues}` };
  }
  return { ok: true, value: { path: manifestPath, manifest: parsed.data } };
}

function existsAsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
