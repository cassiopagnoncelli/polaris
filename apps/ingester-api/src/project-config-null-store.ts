/**
 * A store that holds nothing.
 *
 * `buildIngesterApp` accepts an `apiKeyRepository` without a `db` handle —
 * tests do this, and so could a caller wiring its own persistence. There is
 * then no connection to build a real project-config store on, and the ingest
 * path still has to resolve a dedupe window and a rate limit for every batch.
 *
 * This is the honest answer for that case: every lookup misses, so every
 * project resolves to the deployment defaults — exactly the behaviour before
 * per-project configuration existed. The alternative, making the lookup
 * nullable and branching at both call sites, would put an `undefined` check on
 * the hot path to describe a condition that is fixed at construction.
 *
 * `warm` and `pin` are the only members that could mislead: `warm` succeeds
 * having cached nothing (correct — there is nowhere to cache), and `pin`
 * throws, because a caller that pins is asking for a guarantee this cannot
 * make. The ingester never pins.
 */

import type {
  PinnedConfig,
  ProjectConfigKey,
  ProjectConfigSnapshot,
  ProjectConfigStore,
} from "@polaris/shared-project-config";

export function nullProjectConfigStore(): ProjectConfigStore {
  const empty = (key: ProjectConfigKey): ProjectConfigSnapshot => ({
    projectId: key.projectId,
    environment: key.environment,
    namespace: key.namespace,
    version: 0n,
    values: Object.freeze({}),
    resolvedAt: 0,
    toJSON: () => ({
      projectId: key.projectId,
      environment: key.environment,
      namespace: key.namespace,
      version: "0",
      resolvedAt: 0,
      values: {},
    }),
  });

  return {
    get: async (key) => empty(key),
    // Undefined, not an empty snapshot: a miss is what callers branch on to
    // reach their deployment default, and returning a snapshot would claim
    // "this project has explicitly configured nothing".
    peek: () => undefined,
    warm: async () => undefined,
    pin: async (): Promise<PinnedConfig> => {
      throw new Error(
        "project config is unavailable: buildIngesterApp was given an apiKeyRepository without a db handle",
      );
    },
    invalidate: () => undefined,
    invalidateAll: () => undefined,
    start: async () => undefined,
    close: async () => undefined,
  };
}
