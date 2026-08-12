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
 * The Zod schema mirrors `apps/polaris-cli/src/catalog/processors.ts` for
 * the fields that shipped first; P8-006 adds the cross-cutting fields
 * (`release_status`, `replay_notes`, `fixtures`) that the standardised
 * processor-manifest contract needs. The CLI's copy of the schema stays
 * `.strict()` and will surface those new fields as warnings until a
 * follow-up consolidates the duplication. See
 * `docs/development/processor-manifests.md` for the convergence plan.
 *
 * The loader rejects unknown top-level keys (`.strict()`) so a typo in a
 * manifest fails at boot rather than silently being ignored.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
 * runtime resolver in `@polaris/shared-transport` turns the family into
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
  })
  .passthrough();
export type ProcessorDefaults = z.infer<typeof processorDefaultsSchema>;

/**
 * Release status of a processor version. P8-006 standardises this as a
 * closed set so tooling can reason about lifecycle without parsing prose.
 *
 *   - `released`     v1 production semantics. Immutable per the
 *                    architecture's "Processor Versioning" rule.
 *   - `deprecated`   superseded by a newer version. Still consumable for
 *                    replay; no new processor runs should target it.
 *   - `experimental` opt-in, not yet promoted. Tests and smoke harnesses
 *                    may use it; production activations should not.
 */
export const PROCESSOR_RELEASE_STATUSES = ["released", "deprecated", "experimental"] as const;
export const processorReleaseStatusSchema = z.enum(PROCESSOR_RELEASE_STATUSES);
export type ProcessorReleaseStatus = z.infer<typeof processorReleaseStatusSchema>;

/**
 * Golden-fixture pair declared by a processor manifest. Mirrors the
 * P8-006 convention: each scenario carries one `<name>.input.json` and one
 * `<name>.output.json` under the processor's test directory. The paths are
 * relative to the manifest file (so the loader can resolve them without
 * knowing the repo root).
 *
 * Fixtures are intentionally OPTIONAL on the schema so existing manifests
 * keep parsing during the rollout. Real v1 processors set this block; new
 * processors without fixtures fail their own per-processor manifest test
 * rather than the cross-cutting schema check.
 */
export const processorFixtureSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._-]*$/u, {
        message: "fixture name must be lowercase, alphanumerics + `._-`",
      }),
    input: z.string().min(1).max(512),
    output: z.string().min(1).max(512),
    description: z.string().trim().min(1).max(2048).optional(),
  })
  .strict();
export type ProcessorFixture = z.infer<typeof processorFixtureSchema>;

/**
 * Shape of `processors/<name>/v<n>/processor.manifest.yaml`. Rejects
 * unknown top-level keys via `.strict()`.
 *
 * P8-006 adds three optional top-level fields to the v1 manifest contract:
 *
 *   - `release_status` — closed-set lifecycle flag for the version,
 *   - `replay_notes`   — free-form prose summarising how this version
 *                        behaves under replay; the `replay.restrictions`
 *                        array remains the machine-readable surface,
 *   - `fixtures`       — golden input/output pairs the processor's tests
 *                        load as canonical contract examples.
 *
 * All three default to absent so prior manifests parse unchanged. New
 * manifests are expected to set `release_status` and at least one fixture
 * pair (the per-processor `manifest.test.ts` enforces it).
 */
export const processorManifestSchema = z
  .object({
    name: processorNameSchema,
    version: processorVersionSchema,
    owner: z.string().trim().min(1).max(128),
    description: z.string().trim().min(1).max(8192),
    release_status: processorReleaseStatusSchema.optional(),
    mode: processorModeSchema,
    inputs: z.array(processorTopicSpecSchema).min(1),
    outputs: z.array(processorTopicSpecSchema).min(1),
    state_stores: z.array(z.string()).default([]),
    defaults: processorDefaultsSchema.optional(),
    replay: processorReplaySchema.optional(),
    replay_notes: z.string().trim().min(1).max(8192).optional(),
    fixtures: z.array(processorFixtureSchema).optional(),
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

/**
 * One issue surfaced by `validateProcessorFixtures`. Carries the absolute
 * path of the offending file so test failures and CI output point at the
 * exact location.
 */
export interface ProcessorFixtureIssue {
  /** Fixture entry's `name` slot, or `<root>` for shape-level problems. */
  readonly fixture: string;
  /** Absolute path of the file we expected to find / parse. */
  readonly path: string;
  /** Human-readable reason. */
  readonly reason: string;
}

/** Result of `validateProcessorFixtures`. */
export interface ProcessorFixtureValidation {
  /** Absolute paths the validator resolved and confirmed. */
  readonly resolvedPaths: readonly string[];
  /** Issues — empty array means "OK". */
  readonly issues: readonly ProcessorFixtureIssue[];
}

/**
 * Options for `validateProcessorFixtures`. The fixture paths in the
 * manifest are resolved against `manifestPath`'s parent directory unless
 * they are absolute (which they should NOT be in checked-in YAML, but the
 * resolver tolerates both for ad-hoc tooling).
 */
export interface ValidateProcessorFixturesOptions {
  /** Absolute path to the manifest YAML file. */
  readonly manifestPath: string;
  /** Parsed manifest carrying the optional `fixtures` block. */
  readonly manifest: Pick<ProcessorManifest, "fixtures">;
}

/**
 * Walk the manifest's `fixtures` block and confirm each `input` / `output`
 * pair points at a real, readable JSON file. Returns the resolved paths
 * and an array of structured issues — callers can fail their test with a
 * single message, or surface each issue individually.
 *
 * The helper does NOT compare input → expected-output values; processors
 * own that assertion in their per-scenario transform tests. The helper
 * only enforces the on-disk contract: a manifest that names a fixture
 * must point at files that exist and parse as JSON.
 *
 * Manifests without a `fixtures` block return an empty issue list and an
 * empty `resolvedPaths` array. The helper is lenient on absent fixtures
 * because the rollout grandfathers existing manifests — per-processor
 * tests assert presence where the processor opts in.
 */
export function validateProcessorFixtures(
  options: ValidateProcessorFixturesOptions,
): ProcessorFixtureValidation {
  const fixtures = options.manifest.fixtures ?? [];
  const baseDir = dirname(options.manifestPath);
  const resolved: string[] = [];
  const issues: ProcessorFixtureIssue[] = [];

  const seenNames = new Set<string>();
  for (const fixture of fixtures) {
    if (seenNames.has(fixture.name)) {
      issues.push({
        fixture: fixture.name,
        path: options.manifestPath,
        reason: `duplicate fixture name "${fixture.name}" in manifest`,
      });
      continue;
    }
    seenNames.add(fixture.name);

    for (const slot of ["input", "output"] as const) {
      const relative = fixture[slot];
      const absolute = isAbsolute(relative) ? relative : resolve(baseDir, relative);
      if (!existsSync(absolute)) {
        issues.push({
          fixture: fixture.name,
          path: absolute,
          reason: `fixture ${slot} file does not exist (referenced as "${relative}")`,
        });
        continue;
      }
      try {
        const text = readFileSync(absolute, "utf8");
        JSON.parse(text);
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        issues.push({
          fixture: fixture.name,
          path: absolute,
          reason: `fixture ${slot} file is not valid JSON: ${reason}`,
        });
        continue;
      }
      resolved.push(absolute);
    }
  }

  return { resolvedPaths: resolved, issues };
}
