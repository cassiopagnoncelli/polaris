/**
 * meta-capi's per-`(project, environment)` configuration contract.
 *
 * The C3 generator reads this module from the built entry to produce
 * `@polaris/project-config-schemas`, which the admin UI's typed form and
 * `polaris config validate` both work from. Adding a key here and
 * regenerating is the whole opt-in.
 *
 * Every key is OPTIONAL with no schema default, deliberately. Absent means
 * "use the value this consumer was constructed with" — the deployment
 * default, which is exactly what `POLARIS_META_CAPI_*` meant before the
 * cutover. A schema default would look tidier and would silently override an
 * operator who tuned those variables for their deployment.
 *
 * What is NOT here: the access token. The credential lives in `secret_value`
 * on the DESTINATION row, not in project config, and the split is deliberate
 * now that both are plaintext in the same database. A destination credential
 * belongs to one instance — two Meta pixels for one project have two — and it
 * is write-only through every Polaris surface, rotated with
 * `polaris destinations rotate-secret`. The keys here are project-wide values
 * an operator reads back routinely.
 *
 * @see docs/implementation/project-config-plan.md §3.1
 */

import { positiveIntSchema } from "@polaris/shared-config";
import { z } from "zod";

/** Namespace this consumer reads. One slice per component (plan §3.5). */
export const PROJECT_CONFIG_NAMESPACE = "meta-capi";

/**
 * Parsed in STRIP mode, never `.strict()`: a project may declare free-form
 * keys this build knows nothing about, and a strict parse would fail the
 * whole slice — and therefore every delivery for that project — the moment
 * one appeared (plan §3.5).
 */
export const projectConfigSchema = z.object({
  /** Meta Graph API host. Overridden for staging or test endpoints. */
  graph_host: z.string().min(1).optional(),
  /** Per-attempt HTTP timeout, milliseconds. */
  request_timeout_ms: positiveIntSchema.optional(),
});

/*
 * `allow_replay` was declared here and read by nothing.
 *
 * Replay suppression runs in the destination runtime's `processOne`, at step 2,
 * long before the deliverer — and the `ProjectConfigLookup` seam only feeds
 * `DelivererContext.projectConfig`. So an operator could run
 * `polaris config set --key allow_replay --value true`, see it in
 * `config list`, and have it change nothing.
 *
 * It is not worth plumbing, either: replay already has two gates, the
 * host-level `POLARIS_META_CAPI_ALLOW_REPLAY` and the per-instance
 * `destinations.replay_opt_in`. The second is strictly better than a
 * per-project flag would be — finer-grained, audited, and with
 * `polaris destinations enable-replay` / `disable-replay` behind it.
 *
 * `scripts/lint-project-config-keys.mjs` now fails on a declared key its
 * component never reads, so this cannot recur silently.
 */

export type MetaCapiProjectConfig = z.infer<typeof projectConfigSchema>;

/**
 * Parse one raw slice, falling back to an empty result rather than throwing.
 *
 * A malformed stored value must degrade to the deployment default, not fail
 * the delivery: the value is operator-supplied and the alternative is
 * dead-lettering a producer's events over a typo in an unrelated setting.
 */
export function parseMetaCapiProjectConfig(
  values: Readonly<Record<string, unknown>>,
): MetaCapiProjectConfig {
  const result = projectConfigSchema.safeParse(values);
  return result.success ? result.data : {};
}
