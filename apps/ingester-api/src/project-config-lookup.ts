/**
 * The ingest request path's view of project configuration.
 *
 * Everything here is SYNCHRONOUS by construction. Both values it resolves are
 * needed on every batch, and an inline `store.get()` could assemble — putting a
 * database round-trip, and possibly a secret resolution, inside ingest p99.
 * Plan §4.5 forbids exactly that, so this reads the cache and nothing else.
 *
 * The cache is filled two ways: {@link ProjectConfigStore.warm} at boot for
 * every active project, and a background refresh scheduled on a miss. A miss
 * is therefore normal and cheap — a project created after boot uses deployment
 * defaults for one batch and is warm by the next.
 *
 * Failure posture is §5's ingest rule throughout: never reject, never block,
 * always fall back to the deployment default and meter it. Rejecting ingest
 * destroys a producer's events irrecoverably, while a briefly-default dedupe
 * window is degraded but recoverable — the asymmetry is not close.
 */

import type { Database } from "@polaris/persistence-postgres";
import type { PolarisEnvironment } from "@polaris/runtime-environments";
import type { Logger } from "@polaris/observability-logger";
import type {
  ProjectConfigKey,
  ProjectConfigSnapshot,
  ProjectConfigStore,
} from "@polaris/tenancy-project-config";
import type { Kysely } from "kysely";
import {
  type IngestProjectConfig,
  PROJECT_CONFIG_NAMESPACE,
  parseIngestProjectConfig,
} from "./project-config.js";

export interface IngestProjectConfigLookup {
  /** Dedupe window for a project, in seconds. Already capped. */
  dedupeWindowSec(projectId: string, environment: PolarisEnvironment): number;
  /** Per-API-key RPS budget for a project. */
  rateLimitRps(projectId: string, environment: PolarisEnvironment): number;
}

export interface IngestProjectConfigLookupOptions {
  readonly store: ProjectConfigStore;
  readonly logger: Logger;
  /** `POLARIS_INGEST_DEDUPE_DEFAULT_WINDOW_SEC`. */
  readonly defaultDedupeWindowSec: number;
  /** `POLARIS_INGEST_DEDUPE_MAX_WINDOW_SEC` — the platform ceiling. */
  readonly maxDedupeWindowSec: number;
  /** `POLARIS_RATE_LIMIT_PER_API_KEY_RPS`. */
  readonly defaultRateLimitRps: number;
  /** Reports a project whose stored slice failed to parse. */
  readonly onInvalidConfig?: (projectId: string, environment: string) => void;
}

/**
 * Prewarm every active project's `ingest` slice.
 *
 * Without this the first batch of each project after a restart resolves to
 * deployment defaults — harmless for one batch, but it makes a rolling deploy
 * briefly ignore every configured override, which is confusing to debug and
 * trivial to avoid. Uses the app's existing db handle, so it adds no
 * dependency.
 *
 * Fire-and-forget by contract: a failure here must not delay or fail startup.
 * The lookup's on-miss refresh is the backstop.
 */
export async function prewarmIngestProjectConfig(input: {
  readonly db: Kysely<Database>;
  readonly store: ProjectConfigStore;
  readonly environment: PolarisEnvironment;
  readonly logger: Logger;
}): Promise<void> {
  try {
    const rows = await input.db
      .selectFrom("projects")
      .select("project_id")
      .where("status", "=", "active")
      .execute();
    await input.store.warm(
      rows.map((row) => ({
        projectId: row.project_id,
        environment: input.environment,
        namespace: PROJECT_CONFIG_NAMESPACE,
      })),
    );
    input.logger.info(
      { component: "ingest.project-config", projects: rows.length },
      "prewarmed project config",
    );
  } catch (err) {
    input.logger.warn(
      { component: "ingest.project-config", err },
      "project-config prewarm failed; each project warms on its first batch instead",
    );
  }
}

export function createIngestProjectConfigLookup(
  options: IngestProjectConfigLookupOptions,
): IngestProjectConfigLookup {
  const { store, logger } = options;
  /** Scopes with a refresh already scheduled, so a burst schedules once. */
  const warming = new Set<string>();
  /** Scopes already reported as malformed, so the log records the transition. */
  const reportedInvalid = new Set<string>();
  /**
   * Parse-once per snapshot. Snapshots are frozen and replaced wholesale on
   * refresh, so object identity is a correct cache key — and without this,
   * a 1000-event batch runs the same Zod parse 1000 times on the hot path.
   * WeakMap, so a replaced snapshot's entry goes with it.
   */
  const parsed = new WeakMap<ProjectConfigSnapshot, IngestProjectConfig>();

  function scheduleWarm(key: ProjectConfigKey): void {
    const scopeKey = `${key.projectId}\0${key.environment}`;
    if (warming.has(scopeKey)) return;
    warming.add(scopeKey);
    // Fire-and-forget: the current request is already answering from the
    // deployment default, and awaiting here would be the blocking read this
    // module exists to avoid.
    void store
      .get(key)
      .catch((err: unknown) => {
        logger.warn(
          {
            component: "ingest.project-config",
            project_id: key.projectId,
            environment: key.environment,
            err,
          },
          "background project-config refresh failed; continuing on deployment defaults",
        );
      })
      .finally(() => {
        warming.delete(scopeKey);
      });
  }

  function read(projectId: string, environment: PolarisEnvironment) {
    const key: ProjectConfigKey = {
      projectId,
      environment,
      namespace: PROJECT_CONFIG_NAMESPACE,
    };
    const snapshot = store.peek(key);
    if (snapshot === undefined) {
      scheduleWarm(key);
      return undefined;
    }
    const memoized = parsed.get(snapshot);
    if (memoized !== undefined) return memoized;
    const { config, error } = parseIngestProjectConfig(snapshot.values);
    parsed.set(snapshot, config);
    if (error !== undefined) {
      const scopeKey = `${projectId}\0${environment}`;
      if (!reportedInvalid.has(scopeKey)) {
        reportedInvalid.add(scopeKey);
        options.onInvalidConfig?.(projectId, environment);
        logger.warn(
          {
            component: "ingest.project-config",
            project_id: projectId,
            environment,
            issues: error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          },
          "project config for the ingest namespace did not parse; using deployment defaults",
        );
      }
    }
    return config;
  }

  return {
    dedupeWindowSec(projectId, environment): number {
      const configured = read(projectId, environment)?.dedupe_window_sec;
      const chosen = configured ?? options.defaultDedupeWindowSec;
      // The cap is applied HERE rather than at write time on purpose: it is a
      // deployment value, so lowering it must take effect immediately for
      // every project, including ones whose stored value predates the change.
      return Math.min(chosen, options.maxDedupeWindowSec);
    },
    rateLimitRps(projectId, environment): number {
      return read(projectId, environment)?.rate_limit_rps ?? options.defaultRateLimitRps;
    },
  };
}
