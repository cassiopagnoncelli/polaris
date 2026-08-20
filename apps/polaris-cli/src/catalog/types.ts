/**
 * Zod schemas + types for the file-backed projects/sources catalog.
 *
 * Polaris is file-heavy and database-light. Project and source declarations
 * live as YAML under `definitions/projects/` and `definitions/sources/<project_id>/`.
 * These schemas describe the on-disk shape; the `loader` module reads them
 * and the CLI commands either render them or materialize them into PostgreSQL
 * (via `polaris projects sync` / `polaris sources sync`).
 *
 * See:
 *   - docs/architecture/02-control-plane.md "Projects and Environments", "Sources"
 *   - db/migrations/20260512000002_create_projects.sql
 *   - db/migrations/20260512000003_create_sources.sql
 */
import {
  POLARIS_ENVIRONMENTS,
  type PolarisEnvironment,
  polarisEnvironmentSchema,
} from "@polaris/shared-environments";
import {
  projectEnrichmentOverrideSchema,
  projectIdentityOverrideSchema,
} from "@polaris/shared-policy";
import { z } from "zod";

/**
 * Fixed environment set. Future ephemeral environments live behind explicit
 * task scopes and do not enter v1.
 */
export const ENVIRONMENTS = POLARIS_ENVIRONMENTS;
export const environmentSchema = polarisEnvironmentSchema;
export type Environment = PolarisEnvironment;

/**
 * Closed set of source types. Must match the `sources_source_type_allowed`
 * CHECK constraint in `db/migrations/20260512000003_create_sources.sql`.
 */
export const SOURCE_TYPES = ["web", "backend", "mobile", "webhook", "job"] as const;
export const sourceTypeSchema = z.enum(SOURCE_TYPES);
export type SourceType = z.infer<typeof sourceTypeSchema>;

export const PROJECT_STATUSES = ["active", "disabled"] as const;
export const projectStatusSchema = z.enum(PROJECT_STATUSES);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

export const SOURCE_RUNTIMES = ["active", "paused"] as const;
export const sourceRuntimeSchema = z.enum(SOURCE_RUNTIMES);
export type SourceRuntime = z.infer<typeof sourceRuntimeSchema>;

export const SOURCE_STATUSES = ["active", "disabled"] as const;
export const sourceStatusSchema = z.enum(SOURCE_STATUSES);
export type SourceStatus = z.infer<typeof sourceStatusSchema>;

/**
 * Stable identifier pattern. Lowercase, alphanumerics + `_-`, 3-64 chars,
 * cannot start with a digit or end with a separator. Matches the regex used
 * in the matching CHECK constraints so the catalog rejects values PostgreSQL
 * would later refuse.
 */
export const idSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]{1,62}[a-z0-9]$/, {
    message: "must be lowercase, alphanumerics + `_-`, 3-64 chars",
  });

/**
 * Shape of `definitions/projects/<project_id>.yaml`.
 */
export const projectFileSchema = z
  .object({
    project_id: idSchema,
    display_name: z.string().trim().min(1).max(128),
    owner: z.string().trim().min(1).max(128),
    description: z.string().trim().min(1).max(2048),
    status: projectStatusSchema.default("active"),
    /**
     * Optional identity-stage overrides (identifier denylist, narrowed
     * semantic parameters). Shape shared with the identity stage's boot
     * loader via `@polaris/shared-policy`. Deliberately NOT materialized
     * by `projects sync`: semantic parameters never enter PostgreSQL.
     */
    identity: projectIdentityOverrideSchema.optional(),
    /** Optional enrichment-stage overrides. Same contract as `identity`. */
    enrichment: projectEnrichmentOverrideSchema.optional(),
  })
  .strict();
export type ProjectFile = z.infer<typeof projectFileSchema>;

/**
 * Shape of `definitions/sources/<project_id>/<source_id>.yaml`.
 */
export const sourceFileSchema = z
  .object({
    project_id: idSchema,
    source_id: idSchema,
    source_type: sourceTypeSchema,
    owner: z.string().trim().min(1).max(128),
    description: z.string().trim().min(1).max(2048),
    runtime: sourceRuntimeSchema.default("active"),
    allowed_environments: z.array(environmentSchema).min(1).max(ENVIRONMENTS.length),
    status: sourceStatusSchema.default("active"),
  })
  .strict()
  .superRefine((entry, ctx) => {
    const seen = new Set<Environment>();
    for (let i = 0; i < entry.allowed_environments.length; i += 1) {
      const env = entry.allowed_environments[i];
      if (env === undefined) continue;
      if (seen.has(env)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["allowed_environments", i],
          message: `duplicate environment "${env}"`,
        });
        return;
      }
      seen.add(env);
    }
  });
export type SourceFile = z.infer<typeof sourceFileSchema>;

/**
 * The catalog as loaded from disk. Loaders return this shape; CLI commands
 * render or sync it.
 */
export interface LoadedCatalog {
  readonly root: string;
  readonly projects: readonly ProjectFile[];
  readonly sources: readonly SourceFile[];
}
