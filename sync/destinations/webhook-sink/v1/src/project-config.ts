/**
 * webhook-sink's per-`(project, environment)` configuration contract.
 *
 * The C3 generator reads this module from the built entry to produce
 * `@polaris/project-config-schemas`, which the admin UI's typed form and
 * `polaris config validate` both work from. Adding a key here and
 * regenerating is the whole opt-in.
 *
 * Every key is OPTIONAL with no schema default, deliberately. Absent means
 * "use the value this consumer was constructed with" — the deployment
 * default, which is exactly what `POLARIS_WEBHOOK_SINK_*` meant before the
 * cutover. A schema default would look tidier and would silently override an
 * operator who tuned those variables for their deployment.
 *
 * Every key declared here is READ by `deliverer.ts`, and
 * `scripts/lint-project-config-keys.mjs` fails the build if one is not. A key
 * an operator can set, see in `config list`, and have change nothing is the
 * failure this repo keeps shipping.
 *
 * ## Why there is no `api_host` here, unlike every sibling consumer
 *
 * There is no vendor host to override: the receiver URL IS this destination's
 * credential, stored in `destinations.secret_value` and rotated with
 * `polaris destinations rotate-secret`. A project-wide host override would
 * have to win over a per-instance URL to mean anything, which is backwards —
 * two webhook destinations for one project point at two different receivers by
 * definition.
 *
 * That leaves one key. A single-key slice is worth having anyway: the timeout
 * is the knob operators actually reach for when one project's receiver is
 * slower than the fleet default, and today that is a redeploy.
 *
 * @see docs/implementation/project-config-plan.md §3.1
 */

import { positiveIntSchema } from "@polaris/shared-config";
import { z } from "zod";

/** Namespace this consumer reads. One slice per component (plan §3.5). */
export const PROJECT_CONFIG_NAMESPACE = "webhook-sink";

/**
 * Parsed in STRIP mode, never `.strict()`: a project may declare free-form
 * keys this build knows nothing about, and a strict parse would fail the
 * whole slice — and therefore every delivery for that project — the moment
 * one appeared (plan §3.5).
 */
export const projectConfigSchema = z.object({
  /** Per-attempt HTTP timeout, milliseconds. */
  request_timeout_ms: positiveIntSchema.optional(),
});

export type WebhookSinkProjectConfig = z.infer<typeof projectConfigSchema>;

/**
 * Parse one raw slice, falling back to an empty result rather than throwing.
 *
 * A malformed stored value must degrade to the deployment default, not fail
 * the delivery: the value is operator-supplied and the alternative is
 * dead-lettering a producer's events over a typo in an unrelated setting.
 */
export function parseWebhookSinkProjectConfig(
  values: Readonly<Record<string, unknown>>,
): WebhookSinkProjectConfig {
  const result = projectConfigSchema.safeParse(values);
  return result.success ? result.data : {};
}
