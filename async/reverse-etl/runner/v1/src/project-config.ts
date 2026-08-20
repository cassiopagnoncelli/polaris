/**
 * The reverse-ETL runner's per-`(project, environment)` configuration.
 *
 * §6 of the redesign names three things as `project_config` concerns —
 * schedule, enablement and params. Enablement was the one genuinely
 * missing; this module declares its key and `enablement.ts` enforces it.
 * The other two are answered below rather than implemented, because
 * implementing them would have meant building mechanisms the platform
 * deliberately does not have.
 *
 * ## Enablement: `enabled_jobs`
 *
 * Before this, a job ran for whichever project the crontab named, and the
 * only way to stop it for one project was to edit a crontab on a host. An
 * operator asking "is the LTV writeback on for this customer?" had to read
 * `crontab -l` on the box, and turning it off meant a deploy.
 *
 * `enabled_jobs` moves that answer into the control plane, where the rest
 * of a project's posture lives and where `polaris config get` can read it.
 * The decision itself is `jobEnabled` in `enablement.ts`.
 *
 * **Absent means no restriction, not "nothing is enabled".** The opposite
 * default reads as safer and is worse: every existing crontab entry would
 * start exiting silently the moment this key shipped, having changed
 * nothing, and a writeback that stops without failing is the exact shape
 * this whole command's non-zero-exit rule exists to prevent. An explicit
 * `[]` means "none" and is the way to say it deliberately.
 *
 * ## Schedule: NOT here, and that is not an oversight
 *
 * Every scheduled verb in Polaris is a host crontab entry invoking the CLI
 * — `polaris traits compute`, `polaris audiences compute`, `polaris
 * warehouse export`, `polaris journeys sweep`. Putting one of the five in
 * `project_config` would mean a scheduler that reads the database and
 * fires jobs, which is a daemon this platform does not have and would be a
 * second, weaker cron. The `enabled` half is the part that belongs in
 * config, because it is a per-project fact; the schedule is a deployment
 * fact and lives with the deployment.
 *
 * ## Params: NOT here either
 *
 * A job's SQL binds exactly `{project:String}` and `{environment:String}`,
 * which is what makes "a job cannot widen its own scope" checkable rather
 * than merely intended — `lint-trait-sql.mjs` enforces the projection
 * allowlist and `check-catalog-sql.mjs` runs the SQL against the real
 * schema. A per-project parameter would be a third bound value that the
 * job's own SQL text decides how to use, and a value from the control
 * plane reaching into a query is precisely the seam those two checks
 * exist to keep closed. A job that needs to behave differently per project
 * is a different job, and the registry is keyed for that.
 *
 * @see docs/implementation/project-config-plan.md §3.1
 */

import { z } from "zod";

/** Namespace this component reads. One slice per component (plan §3.5). */
export const PROJECT_CONFIG_NAMESPACE = "reverse_etl";

/** Job keys, matching `ReverseEtlJob.key` in `definitions/reverse-etl`. */
const jobKeySchema = z.string().regex(/^[a-z][a-z0-9_]*$/u, {
  message: "a job key is lowercase alphanumerics and underscores, e.g. ltv_writeback",
});

/**
 * Parsed in STRIP mode, never `.strict()`: this namespace also holds
 * `ingest_api_key`, an `is_secret` value the CLI reads directly through
 * `revealProjectConfigSecret` rather than through this schema. A strict
 * parse would reject the whole slice the moment that key was set — which
 * is every project that has ever run a job.
 */
export const projectConfigSchema = z.object({
  /**
   * Which jobs may run for this project. Absent means no restriction; an
   * explicit empty list means none. See the module header for why those
   * are different.
   */
  enabled_jobs: z.array(jobKeySchema).optional(),
});

export type ReverseEtlProjectConfig = z.infer<typeof projectConfigSchema>;
