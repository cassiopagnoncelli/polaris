/**
 * ga4's per-`(project, environment)` configuration contract.
 *
 * The C3 generator reads this module from the built entry to produce
 * `@polaris/project-config-schemas`, which the admin UI's typed form and
 * `polaris config validate` both work from. Adding a key here and
 * regenerating is the whole opt-in.
 *
 * Every key is OPTIONAL with no schema default, deliberately. Absent means
 * "use the value this consumer was constructed with" — the deployment
 * default, which is exactly what `POLARIS_GA4_*` meant before the cutover. A
 * schema default would look tidier and would silently override an operator who
 * tuned those variables for their deployment.
 *
 * Every key declared here is READ by `deliverer.ts`, and
 * `scripts/lint-project-config-keys.mjs` fails the build if one is not. A key
 * an operator can set, see in `config list`, and have change nothing is the
 * failure this repo keeps shipping.
 *
 * What is NOT here: the credential. `{measurement_id, api_secret}` lives in
 * `destinations.secret_value` on the destination row, because it belongs to
 * one instance rather than to the project — two GA4 streams for one project
 * have two — and because it is write-only through every Polaris surface.
 *
 * @see docs/implementation/project-config-plan.md §3.1
 */

import { positiveIntSchema } from "@polaris/shared-config";
import { ROUTING_GATE_CONFIG_KEY } from "@polaris/shared-destinations";
import { z } from "zod";

/** Namespace this consumer reads. One slice per component (plan §3.5). */
export const PROJECT_CONFIG_NAMESPACE = "ga4";

/**
 * Parsed in STRIP mode, never `.strict()`: a project may declare free-form
 * keys this build knows nothing about, and a strict parse would fail the
 * whole slice — and therefore every delivery for that project — the moment
 * one appeared (plan §3.5).
 */
export const projectConfigSchema = z.object({
  /**
   * Routing gate configuration — WHICH events reach this destination.
   *
   * Read by the SHARED destination runtime (`packages/shared-destinations`),
   * not by this consumer: the gate runs inside `processOne`, ahead of
   * normalize, so it is decided before any vendor code is reached. Declared
   * here anyway because the namespace is what `polaris config set` validates
   * against and what the admin panel renders — a key an operator cannot
   * discover is a key nobody uses.
   *
   * Shape: `{ subscriptions?: { events?, prefixes? }, filters?: [{ path, op,
   * value? }], requireConsent?: [...] }`. Validated structurally by
   * `parseRoutingGateConfig`, not here, because the runtime must degrade to
   * "unconfigured" on a malformed value rather than fail the slice — and a
   * Zod shape duplicated in two places is a shape that drifts.
   *
   * Never mapping semantics. Configuration decides WHETHER an event goes to
   * a vendor, never what it looks like on arrival.
   */
  [ROUTING_GATE_CONFIG_KEY]: z.record(z.string(), z.unknown()).optional(),
  /** Measurement Protocol host. Overridden for staging or test endpoints. */
  api_host: z.string().min(1).optional(),
  /** Per-attempt HTTP timeout, milliseconds. */
  request_timeout_ms: positiveIntSchema.optional(),
});

export type Ga4ProjectConfig = z.infer<typeof projectConfigSchema>;

/**
 * Parse one raw slice, falling back to an empty result rather than throwing.
 *
 * A malformed stored value must degrade to the deployment default, not fail
 * the delivery: the value is operator-supplied and the alternative is
 * dead-lettering a producer's events over a typo in an unrelated setting.
 */
export function parseGa4ProjectConfig(values: Readonly<Record<string, unknown>>): Ga4ProjectConfig {
  const result = projectConfigSchema.safeParse(values);
  return result.success ? result.data : {};
}
