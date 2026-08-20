/**
 * The ingester's per-`(project, environment)` configuration contract.
 *
 * This module is the source of truth the C3 generator reads to produce
 * `@polaris/tenancy-config-schemas`; the admin UI's typed form and
 * `polaris config validate` both work from that artifact. Adding a key here
 * and regenerating is the whole opt-in.
 *
 * Both keys are **optional with no default**, deliberately. Absent means "use
 * the deployment default" — `POLARIS_INGEST_DEDUPE_DEFAULT_WINDOW_SEC` and
 * `POLARIS_RATE_LIMIT_PER_API_KEY_RPS` — which is exactly what the
 * comma-separated override strings meant before this. A schema default would
 * look tidier and would silently override an operator who tuned those
 * variables for their deployment.
 *
 * What is NOT here: `POLARIS_INGEST_DEDUPE_MAX_WINDOW_SEC`. It is the ceiling
 * a project may opt in *up to*, so making it per-project would let a project
 * raise its own limit — a guardrail that guards nothing. It stays a
 * deployment value and is applied after the project value is read.
 *
 * @see docs/implementation/project-config-plan.md §3.1
 */

import { positiveIntSchema } from "@polaris/runtime-config";
import { z } from "zod";

/** Namespace this component reads. One slice per component (plan §3.5). */
export const PROJECT_CONFIG_NAMESPACE = "ingest";

/**
 * Parsed in STRIP mode, never `.strict()`: a project may declare free-form
 * keys this component knows nothing about, and a strict parse would fail the
 * whole slice the moment one appeared (plan §3.5).
 */
export const projectConfigSchema = z.object({
  /**
   * Ingress dedupe window for this project, seconds. Capped by
   * `POLARIS_INGEST_DEDUPE_MAX_WINDOW_SEC` at use.
   */
  dedupe_window_sec: positiveIntSchema.optional(),
  /** Per-API-key request budget for this project, requests per second. */
  rate_limit_rps: positiveIntSchema.optional(),
});

export type IngestProjectConfig = z.infer<typeof projectConfigSchema>;

/**
 * Parse one snapshot's values into this component's shape.
 *
 * Returns an empty object when the slice does not parse, rather than throwing:
 * on the ingest path a malformed value must degrade to the deployment default,
 * not reject a producer's events (plan §5).
 */
export function parseIngestProjectConfig(values: Readonly<Record<string, unknown>>): {
  readonly config: IngestProjectConfig;
  readonly error: z.ZodError | undefined;
} {
  const result = projectConfigSchema.safeParse(values);
  if (result.success) return { config: result.data, error: undefined };
  return { config: {}, error: result.error };
}
