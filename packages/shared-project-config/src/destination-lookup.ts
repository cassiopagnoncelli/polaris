/**
 * Adapter from the project-config store to the destination runtime's
 * `ProjectConfigLookup` seam.
 *
 * The runtime deliberately does not depend on this package — it declares a
 * one-method interface instead, so a consumer that has not cut over takes no
 * dependency on a store it never uses. This is the piece that joins them, and
 * it lives here because it is this package's knowledge of `peek` semantics,
 * not the runtime's.
 *
 * Synchronous and cache-only by construction: delivery is a hot path, and an
 * inline assembly would put a database round-trip and possibly a secret
 * resolution inside it (plan §4.5). A miss returns empty, the deliverer falls
 * back to its deployment defaults, and `peek` has already scheduled the
 * refresh that makes the next delivery warm.
 */

import { isPolarisEnvironment } from "@polaris/shared-environments";
import type { ProjectConfigStore } from "./store.js";

/** Shared so a cold path does not allocate per delivery. */
const EMPTY: Readonly<Record<string, unknown>> = Object.freeze({});

export interface DestinationProjectConfigLookup {
  valuesFor(projectId: string, environment: string): Readonly<Record<string, unknown>>;
}

export function createDestinationProjectConfigLookup(input: {
  readonly store: ProjectConfigStore;
  /** The consumer's namespace, e.g. `meta-capi`. */
  readonly namespace: string;
}): DestinationProjectConfigLookup {
  return {
    valuesFor(projectId, environment) {
      // The envelope's environment is stamped by the ingester from the API
      // key, so it is trustworthy — but it arrives here as a plain string
      // through the runtime's seam, and a value outside the closed set would
      // build a cache key that can never hit. Falling back to empty keeps a
      // malformed envelope on deployment defaults instead of throwing inside
      // a delivery.
      if (!isPolarisEnvironment(environment)) return EMPTY;
      const snapshot = input.store.peek({
        projectId,
        environment,
        namespace: input.namespace,
      });
      return snapshot?.values ?? EMPTY;
    },
  };
}
