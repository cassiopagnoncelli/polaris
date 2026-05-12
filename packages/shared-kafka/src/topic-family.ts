/**
 * Topic-family resolution.
 *
 * Per `docs/architecture/03-redpanda-topics.md`:
 *
 *   Canonical topic names refer to a family, not a fixed concrete topic.
 *   Producers and consumers resolve the family to a concrete topic through
 *   the source registry.
 *
 *   raw.events                 shared default
 *   raw.events.<project_id>    dedicated, created on isolation
 *
 *   The shared-kafka package owns this resolution and exposes a stable
 *   interface to processor and consumer code so isolation is operational,
 *   not structural.
 *
 * Isolation state lives in PostgreSQL (control-plane runtime state, not
 * semantic platform truth). This package stays pure: callers pass an
 * `IsolationLookup` handle that knows how to consult that storage. The
 * default in-memory adapter is provided for tests and bootstrap scenarios.
 */

import { type CanonicalTopicFamily, dedicatedTopicName, isCanonicalTopicFamily } from "./topics.js";

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
  isIsolated(family: CanonicalTopicFamily, projectId: string): Promise<boolean>;
}

/**
 * Sync variant of `IsolationLookup`. Some hot paths (e.g. partition key +
 * topic resolution per produce call) prefer a cache-first sync handle.
 */
export interface SyncIsolationLookup {
  isIsolated(family: CanonicalTopicFamily, projectId: string): boolean;
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
  isolated: ReadonlyArray<{ family: CanonicalTopicFamily; project_id: string }>,
): SyncIsolationLookup {
  const set = new Set(isolated.map((entry) => `${entry.family}::${entry.project_id}`));
  return {
    isIsolated(family, projectId) {
      return set.has(`${family}::${projectId}`);
    },
  };
}

/**
 * Resolve a topic family + project_id to a concrete Redpanda topic name
 * using a sync lookup. Returns the shared family topic when the project is
 * not isolated, or the dedicated topic when it is.
 *
 * Throws when the family is not a recognized canonical family — callers
 * should pass one of the `TOPIC_FAMILY_*` constants from `./topics`.
 */
export function resolveTopicNameSync(
  family: CanonicalTopicFamily | string,
  projectId: string,
  lookup: SyncIsolationLookup,
): string {
  ensureFamily(family);
  if (lookup.isIsolated(family, projectId)) {
    return dedicatedTopicName(family, projectId);
  }
  return family;
}

/**
 * Async variant of `resolveTopicNameSync`. Use when the lookup must touch
 * PostgreSQL (and a cache miss is expected).
 */
export async function resolveTopicName(
  family: CanonicalTopicFamily | string,
  projectId: string,
  lookup: IsolationLookup,
): Promise<string> {
  ensureFamily(family);
  const isolated = await lookup.isIsolated(family, projectId);
  if (isolated) return dedicatedTopicName(family, projectId);
  return family;
}

/**
 * The set of concrete topics a consumer must subscribe to when reading a
 * family. Consumers cannot rely on a single shared topic if any project
 * is isolated; they must subscribe to every dedicated topic plus the
 * shared default. Callers obtain the list of currently-isolated projects
 * from the control plane and pass it here.
 */
export function consumerTopicsForFamily(
  family: CanonicalTopicFamily | string,
  isolatedProjectIds: ReadonlyArray<string>,
): ReadonlyArray<string> {
  ensureFamily(family);
  const dedicated = isolatedProjectIds.map((projectId) => dedicatedTopicName(family, projectId));
  return [family, ...dedicated];
}

function ensureFamily(family: string): asserts family is CanonicalTopicFamily {
  if (!isCanonicalTopicFamily(family)) {
    throw new Error(
      `topic-family resolver: "${family}" is not a canonical Polaris topic family. ` +
        "Use one of the TOPIC_FAMILY_* constants exported from @polaris/shared-kafka.",
    );
  }
}
