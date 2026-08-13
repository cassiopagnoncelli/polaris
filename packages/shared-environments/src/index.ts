/**
 * `@polaris/shared-environments` — the environment vocabularies, defined once.
 *
 * Polaris has two environment sets and they are not the same set. Conflating
 * them is what this package exists to prevent:
 *
 *   - **Row environments** ({@link POLARIS_ENVIRONMENTS}) are data. Every
 *     `environment` column, every envelope slot, every control-plane scope.
 *     The set is closed at three and mirrors the CHECK constraints in
 *     `db/migrations` (`destinations_environment_allowed` and its siblings).
 *   - **Deployment environments** ({@link DEPLOYMENT_ENVIRONMENTS}) are the
 *     domain of `POLARIS_ENV` and nothing else. They add `local` so developer
 *     machines and CI runs have a truthful value to emit.
 *
 * `local` must never reach a row environment column; `test` is not an
 * environment at all. Before this package existed the set was written out
 * independently in eight places and two disagreed — `shared-config` added
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
 * `environment` CHECK constraint in `db/migrations` would need to widen in
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
