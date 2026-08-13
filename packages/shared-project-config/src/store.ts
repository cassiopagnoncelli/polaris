/**
 * The project-config read store.
 *
 * Reads are pure in-memory lookups: the hot path never touches the database
 * except on a cold miss. Freshness comes from two independent mechanisms, and
 * the redundancy is the point —
 *
 *   - `LISTEN/NOTIFY` delivers a change within milliseconds, but is
 *     fire-and-forget: a subscriber reconnecting when a message fires never
 *     sees it;
 *   - a jittered background sweep reconciles every cached scope against
 *     `project_config_versions` in ONE query per tick, so a lost notification
 *     self-heals instead of persisting forever.
 *
 * Invalidation is lazy throughout: a notification or sweep MARKS an entry
 * stale, and the next reader refetches it single-flighted. Eager refetch would
 * have every replica stampede PostgreSQL the instant an operator saves a form.
 *
 * @see docs/implementation/project-config-plan.md §4
 */

import type { Database } from "@polaris/shared-db";
import type { PolarisEnvironment } from "@polaris/shared-environments";
import type { Logger } from "@polaris/shared-logger";
import type { SecretResolver } from "@polaris/shared-secrets";
import type { Kysely } from "kysely";
import {
  assembleSnapshot,
  readVersions,
  scopeKey,
  snapshotHasSecret,
  snapshotKey,
} from "./assemble.js";
import {
  DEFAULT_CACHE_CAPACITY,
  DEFAULT_SWEEP_INTERVAL_MS,
  SECRET_REFRESH_DEADLINE_MS,
  SWEEP_JITTER_RATIO,
} from "./constants.js";
import { PinMissingError } from "./errors.js";
import type { ListenerTransport } from "./listener.js";
import { BoundedLru } from "./lru.js";
import type { PinnedConfig, ProjectConfigKey, ProjectConfigSnapshot } from "./types.js";

/**
 * Observability seam.
 *
 * Hooks rather than a metrics dependency: this package must be usable from
 * every service without dictating a metrics client, and tests assert on hook
 * calls without a registry.
 */
export interface ProjectConfigMetricsHooks {
  onCacheLookup?(namespace: string, result: "hit" | "miss" | "stale"): void;
  onResolveDuration?(namespace: string, seconds: number): void;
  onInvalidation?(source: "notify" | "sweep" | "reconnect"): void;
  onEviction?(): void;
  onStaleness?(projectId: string, environment: string, seconds: number): void;
  onListenerUp?(up: boolean): void;
}

export interface ProjectConfigStoreOptions {
  readonly db: Kysely<Database>;
  readonly secrets: SecretResolver;
  readonly listener: ListenerTransport;
  readonly logger: Logger;
  readonly capacity?: number;
  readonly sweepIntervalMs?: number;
  readonly secretRefreshDeadlineMs?: number;
  readonly now?: () => Date;
  readonly metrics?: ProjectConfigMetricsHooks;
}

export interface ProjectConfigStore {
  get(key: ProjectConfigKey): Promise<ProjectConfigSnapshot>;
  pin(keys: readonly ProjectConfigKey[]): Promise<PinnedConfig>;
  invalidate(projectId: string, environment?: PolarisEnvironment): void;
  invalidateAll(): void;
  start(): Promise<void>;
  close(): Promise<void>;
}

interface CacheEntry {
  snapshot: ProjectConfigSnapshot;
  /** Marked by a notification or sweep; the next reader refetches. */
  stale: boolean;
  /** Whether the snapshot holds resolved secrets, and so has a deadline. */
  hasSecret: boolean;
  /** Epoch ms this entry's version was last confirmed against the database. */
  confirmedAt: number;
}

export function createProjectConfigStore(options: ProjectConfigStoreOptions): ProjectConfigStore {
  const now = options.now ?? ((): Date => new Date());
  const metrics = options.metrics ?? {};
  const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const secretDeadlineMs = options.secretRefreshDeadlineMs ?? SECRET_REFRESH_DEADLINE_MS;

  const cache = new BoundedLru<string, CacheEntry>(options.capacity ?? DEFAULT_CACHE_CAPACITY, () =>
    metrics.onEviction?.(),
  );
  /** In-flight assemblies, so N concurrent misses issue ONE query. */
  const inFlight = new Map<string, Promise<ProjectConfigSnapshot>>();
  const keyIndex = new Map<string, ProjectConfigKey>();

  let sweepTimer: NodeJS.Timeout | undefined;
  let closed = false;

  function markStale(cacheKey: string): void {
    const entry = cache.peek(cacheKey);
    if (entry !== undefined) entry.stale = true;
  }

  /** A secret-bearing snapshot expires on its own clock, regardless of version. */
  function pastSecretDeadline(entry: CacheEntry, nowMs: number): boolean {
    return entry.hasSecret && nowMs - entry.snapshot.resolvedAt > secretDeadlineMs;
  }

  async function assembleInto(cacheKey: string, key: ProjectConfigKey) {
    const pending = inFlight.get(cacheKey);
    if (pending !== undefined) return pending;

    const startedAt = now().getTime();
    const promise = assembleSnapshot({
      db: options.db,
      secrets: options.secrets,
      key,
      now,
    })
      .then((snapshot) => {
        const finishedAt = now().getTime();
        metrics.onResolveDuration?.(key.namespace, (finishedAt - startedAt) / 1000);
        cache.set(cacheKey, {
          snapshot,
          stale: false,
          hasSecret: snapshotHasSecret(snapshot),
          confirmedAt: finishedAt,
        });
        keyIndex.set(cacheKey, key);
        return snapshot;
      })
      .finally(() => {
        inFlight.delete(cacheKey);
      });

    inFlight.set(cacheKey, promise);
    return promise;
  }

  async function get(key: ProjectConfigKey): Promise<ProjectConfigSnapshot> {
    const cacheKey = snapshotKey(key);
    const entry = cache.get(cacheKey);
    const nowMs = now().getTime();

    if (entry !== undefined && !entry.stale && !pastSecretDeadline(entry, nowMs)) {
      metrics.onCacheLookup?.(key.namespace, "hit");
      return entry.snapshot;
    }

    metrics.onCacheLookup?.(key.namespace, entry === undefined ? "miss" : "stale");
    // A failed assembly must NOT poison the cache: the entry is only replaced
    // on success, so a transient Vault error means the next read retries.
    return assembleInto(cacheKey, key);
  }

  async function pin(keys: readonly ProjectConfigKey[]): Promise<PinnedConfig> {
    const pinned = new Map<string, ProjectConfigSnapshot>();
    // Deduplicate first: a batch of 500 events across 3 projects must not
    // issue 500 lookups.
    const unique = new Map<string, ProjectConfigKey>();
    for (const key of keys) unique.set(snapshotKey(key), key);

    await Promise.all(
      [...unique.entries()].map(async ([cacheKey, key]) => {
        pinned.set(cacheKey, await get(key));
      }),
    );

    return {
      snapshot(key: ProjectConfigKey): ProjectConfigSnapshot {
        // Reads the pinned map, never the live cache — so an invalidation
        // arriving mid-batch affects the next batch, not this one.
        const found = pinned.get(snapshotKey(key));
        if (found === undefined) {
          throw new PinMissingError(key.projectId, key.environment, key.namespace);
        }
        return found;
      },
    };
  }

  function invalidate(projectId: string, environment?: PolarisEnvironment): void {
    const prefix =
      environment === undefined ? `${projectId}\0` : `${scopeKey(projectId, environment)}\0`;
    for (const cacheKey of cache.keys()) {
      if (cacheKey.startsWith(prefix)) markStale(cacheKey);
    }
  }

  function invalidateAll(): void {
    for (const cacheKey of cache.keys()) markStale(cacheKey);
  }

  /**
   * Apply a change notification.
   *
   * The monotonic guard is what makes duplicated or reordered notifications
   * harmless: a message announcing a version we already hold, or an older one,
   * is ignored rather than thrashing the entry.
   */
  function applyNotification(message: {
    project_id: string;
    environment: string;
    version: bigint;
  }): void {
    const prefix = `${scopeKey(message.project_id, message.environment)}\0`;
    let touched = false;
    for (const cacheKey of cache.keys()) {
      if (!cacheKey.startsWith(prefix)) continue;
      const entry = cache.peek(cacheKey);
      if (entry === undefined) continue;
      if (message.version <= entry.snapshot.version) continue;
      entry.stale = true;
      touched = true;
    }
    if (touched) metrics.onInvalidation?.("notify");
  }

  /**
   * Reconcile every cached scope in one query.
   *
   * Note this reads distinct SCOPES, not cache keys: a process caching ten
   * namespaces for one project issues one row's worth of comparison, not ten.
   */
  async function sweep(): Promise<void> {
    const entries = cache.entries();
    if (entries.length === 0) return;

    const scopes = new Map<string, readonly [string, PolarisEnvironment]>();
    for (const [cacheKey] of entries) {
      const key = keyIndex.get(cacheKey);
      if (key === undefined) continue;
      scopes.set(scopeKey(key.projectId, key.environment), [key.projectId, key.environment]);
    }

    const versions = await readVersions(options.db, [...scopes.values()]);
    const nowMs = now().getTime();
    let invalidated = false;

    for (const [cacheKey, entry] of entries) {
      const key = keyIndex.get(cacheKey);
      if (key === undefined) continue;
      const scope = scopeKey(key.projectId, key.environment);
      const dbVersion = versions.get(scope) ?? 0n;

      if (dbVersion > entry.snapshot.version) {
        entry.stale = true;
        invalidated = true;
      } else {
        entry.confirmedAt = nowMs;
      }
      metrics.onStaleness?.(key.projectId, key.environment, (nowMs - entry.confirmedAt) / 1000);
    }

    if (invalidated) metrics.onInvalidation?.("sweep");
  }

  function scheduleSweep(): void {
    if (closed) return;
    // Jitter per tick, not once: a fleet deployed together must not converge
    // back into lockstep after the first sweep.
    const jitter = 1 + (Math.random() * 2 - 1) * SWEEP_JITTER_RATIO;
    sweepTimer = setTimeout(
      () => {
        void sweep()
          .catch((err: unknown) => {
            // A failed sweep is not fatal: entries keep their last-known values
            // and the staleness gauge climbs, which is the alertable signal.
            options.logger.warn(
              { component: "project-config.sweep", err },
              "project-config sweep failed; serving cached values",
            );
          })
          .finally(() => {
            scheduleSweep();
          });
      },
      Math.max(1, Math.round(sweepIntervalMs * jitter)),
    );
    sweepTimer.unref?.();
  }

  return {
    get,
    pin,
    invalidate,
    invalidateAll,
    async start(): Promise<void> {
      closed = false;
      await options.listener.start({
        onMessage: applyNotification,
        onReconnect: (): void => {
          // Notifications during the gap are lost, so nothing cached can be
          // trusted. Dropping everything is the only correct recovery.
          invalidateAll();
          metrics.onInvalidation?.("reconnect");
        },
        onUp: (up: boolean): void => metrics.onListenerUp?.(up),
      });
      scheduleSweep();
    },
    async close(): Promise<void> {
      closed = true;
      if (sweepTimer !== undefined) {
        clearTimeout(sweepTimer);
        sweepTimer = undefined;
      }
      await options.listener.close();
    },
  };
}
