/**
 * Stream-family resolution.
 *
 * Per `docs/architecture/03-rabbitmq-streams.md`:
 *
 *   Canonical stream names refer to a family, not a fixed concrete super
 *   stream. Producers and consumers resolve the family to a concrete
 *   super stream through the source registry.
 *
 *   raw.events                 shared default
 *   raw.events.<project_id>    dedicated, created on isolation
 *
 *   The shared-transport package owns this resolution and exposes a
 *   stable interface to processor and consumer code so isolation is
 *   operational, not structural.
 *
 * Isolation state lives in PostgreSQL (control-plane runtime state, not
 * semantic platform truth). This package stays pure: callers pass an
 * `IsolationLookup` handle that knows how to consult that storage. The
 * default in-memory adapter is provided for tests and bootstrap scenarios.
 *
 * Note that resolution returns a **family** name, not a queue: the
 * concrete partition streams behind it come from
 * `partitionStreamNames(family, partitions)`.
 */

import {
  type CanonicalStreamFamily,
  dedicatedStreamFamily,
  isCanonicalStreamFamily,
} from "./streams.js";

/**
 * Async lookup contract: given a (family, project_id) pair, return whether
 * that project is currently isolated for that family. The contract is
 * deliberately minimal so PostgreSQL-backed adapters in `apps/` and the
 * control plane can implement it without leaking schema details into this
 * package.
 *
 * Implementations should be safe to call frequently — production callers
 * will memoize results behind a small LRU.
 */
export interface IsolationLookup {
  isIsolated(family: CanonicalStreamFamily, projectId: string): Promise<boolean>;
}

/**
 * Sync variant of `IsolationLookup`. Some hot paths (e.g. partition key +
 * stream resolution per publish call) prefer a cache-first sync handle.
 */
export interface SyncIsolationLookup {
  isIsolated(family: CanonicalStreamFamily, projectId: string): boolean;
}

/**
 * Test/bootstrap adapter that always returns "not isolated". Useful when a
 * service needs to wire up the resolver before the control plane is
 * available, and for tests of producer/consumer wiring where isolation is
 * not under test.
 */
export const sharedOnlyIsolationLookup: SyncIsolationLookup = {
  isIsolated() {
    return false;
  },
};

/**
 * Build a sync isolation lookup from a static set of isolated (family,
 * project_id) pairs. Intended for unit tests and seed data.
 */
export function staticIsolationLookup(
  isolated: ReadonlyArray<{ family: CanonicalStreamFamily; project_id: string }>,
): SyncIsolationLookup {
  const set = new Set(isolated.map((entry) => `${entry.family}::${entry.project_id}`));
  return {
    isIsolated(family, projectId) {
      return set.has(`${family}::${projectId}`);
    },
  };
}

/**
 * Resolve a stream family + project_id to a concrete super-stream name
 * using a sync lookup. Returns the shared family when the project is not
 * isolated, or the dedicated family when it is.
 *
 * Throws when the family is not a recognized canonical family — callers
 * should pass one of the `STREAM_FAMILY_*` constants from `./streams`.
 */
export function resolveStreamFamilySync(
  family: CanonicalStreamFamily | string,
  projectId: string,
  lookup: SyncIsolationLookup,
): string {
  ensureFamily(family);
  if (lookup.isIsolated(family, projectId)) {
    return dedicatedStreamFamily(family, projectId);
  }
  return family;
}

/**
 * Async variant of `resolveStreamFamilySync`. Use when the lookup must
 * touch PostgreSQL (and a cache miss is expected).
 */
export async function resolveStreamFamily(
  family: CanonicalStreamFamily | string,
  projectId: string,
  lookup: IsolationLookup,
): Promise<string> {
  ensureFamily(family);
  const isolated = await lookup.isIsolated(family, projectId);
  if (isolated) return dedicatedStreamFamily(family, projectId);
  return family;
}

/**
 * Environment-scoped async lookup. The persistent `topic_isolations`
 * table records isolations per `(family, project_id, environment)`
 * because the same project may be isolated in production but not in
 * development. Callers that operate across environments (CLI tooling,
 * the resolver in services that handle more than one environment) pass
 * an environment-aware lookup here.
 *
 * Single-environment callers should prefer the v1 `IsolationLookup`
 * adapter exposed by `StreamIsolationCache.forEnvironment(env)`.
 */
export interface ScopedStreamResolverLookup {
  isIsolated(
    family: CanonicalStreamFamily,
    projectId: string,
    environment: string,
  ): Promise<boolean>;
}

/**
 * Async variant of {@link resolveStreamFamily} that consults an
 * environment-scoped lookup. Returns the shared family when the triple is
 * not isolated; returns the dedicated family otherwise.
 *
 * This is the resolver entry point CLI tooling and cross-environment
 * services call; the single-environment producer/consumer hot path stays
 * on the v1 `resolveStreamFamily(...)` signature via the adapter
 * `StreamIsolationCache.forEnvironment(env)`.
 */
export async function resolveStreamFamilyScoped(
  family: CanonicalStreamFamily | string,
  projectId: string,
  environment: string,
  lookup: ScopedStreamResolverLookup,
): Promise<string> {
  ensureFamily(family);
  const isolated = await lookup.isIsolated(family, projectId, environment);
  if (isolated) return dedicatedStreamFamily(family, projectId);
  return family;
}

/**
 * The set of concrete super streams a consumer must read when consuming a
 * family. Consumers cannot rely on a single shared family if any project
 * is isolated; they must read every dedicated super stream plus the shared
 * default. Callers obtain the list of currently-isolated projects from the
 * control plane and pass it here.
 */
export function consumerFamiliesFor(
  family: CanonicalStreamFamily | string,
  isolatedProjectIds: ReadonlyArray<string>,
): ReadonlyArray<string> {
  ensureFamily(family);
  const dedicated = isolatedProjectIds.map((projectId) => dedicatedStreamFamily(family, projectId));
  return [family, ...dedicated];
}

function ensureFamily(family: string): asserts family is CanonicalStreamFamily {
  if (!isCanonicalStreamFamily(family)) {
    throw new Error(
      `stream-family resolver: "${family}" is not a canonical Polaris stream family. ` +
        "Use one of the STREAM_FAMILY_* constants exported from @polaris/shared-transport.",
    );
  }
}
