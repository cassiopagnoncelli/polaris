/**
 * `@polaris/runtime-environments` — the environment vocabularies, defined once.
 *
 * Polaris has two environment sets and they are not the same set. Conflating
 * them is what this package exists to prevent:
 *
 *   - **Row environments** ({@link POLARIS_ENVIRONMENTS}) are data. Every
 *     `environment` column, every envelope slot, every control-plane scope.
 *     The set is closed at three and mirrors the CHECK constraints in
 *     `db/postgres/migrations` (`destinations_environment_allowed` and its siblings).
 *   - **Deployment environments** ({@link DEPLOYMENT_ENVIRONMENTS}) are the
 *     domain of `POLARIS_ENV` and nothing else. They add `local` so developer
 *     machines and CI runs have a truthful value to emit.
 *
 * `local` must never reach a row environment column; `test` is not an
 * environment at all. Before this package existed the set was written out
 * independently in eight places and two disagreed — `runtime-config` added
 * `local` (correctly, for `POLARIS_ENV`) and `shared-schemas` added `test`
 * (a bug: no environment-checked table accepts it, so such an envelope failed
 * every downstream CHECK).
 *
 * This is the ONLY place either set may be defined. Every other module
 * re-exports from here, keeping its own historical names as aliases.
 *
 * @see docs/implementation/project-config-plan.md §15
 */

import { z } from "zod";

/**
 * The closed set of Polaris row/data environments.
 *
 * Adding a variant here is a platform-wide migration, not an edit: every
 * `environment` CHECK constraint in `db/postgres/migrations` would need to widen in
 * lockstep.
 */
export const POLARIS_ENVIRONMENTS = ["development", "staging", "production"] as const;

export type PolarisEnvironment = (typeof POLARIS_ENVIRONMENTS)[number];

export const polarisEnvironmentSchema = z.enum(POLARIS_ENVIRONMENTS);

/** Narrowing predicate for values arriving from outside the type system. */
export function isPolarisEnvironment(value: unknown): value is PolarisEnvironment {
  return typeof value === "string" && (POLARIS_ENVIRONMENTS as readonly string[]).includes(value);
}

/**
 * Deployment environments: the domain of `POLARIS_ENV`.
 *
 * Exactly {@link POLARIS_ENVIRONMENTS} plus `local`. The relationship is
 * asserted in this package's tests so the two sets cannot drift apart.
 */
export const DEPLOYMENT_ENVIRONMENTS = ["local", "development", "staging", "production"] as const;

export type DeploymentEnvironment = (typeof DEPLOYMENT_ENVIRONMENTS)[number];

export const deploymentEnvironmentSchema = z.enum(DEPLOYMENT_ENVIRONMENTS);

/**
 * The row environment a deployment reads and writes by default.
 *
 * Only `local` needs translating, and it is the whole reason this exists: a
 * developer machine is not a row environment, `local` must never reach an
 * `environment` column, and every surface that wants to preselect "the
 * environment I am looking at" would otherwise write its own `=== "local"`
 * check. A local control plane fronts development data, so that is the
 * answer.
 *
 * Deliberately total rather than nullable. Callers are choosing a default for
 * a filter or a form, not validating input — `isPolarisEnvironment` is the
 * predicate for that — and an unrecognised deployment string is safest
 * pointed at development rather than at production.
 */
export function rowEnvironmentFor(deployment: string): PolarisEnvironment {
  return isPolarisEnvironment(deployment) ? deployment : "development";
}
