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
import type { Kysely } from "kysely";
import { assembleSnapshot, readVersions, scopeKey, snapshotKey } from "./assemble.js";
import {
  DEFAULT_CACHE_CAPACITY,
  DEFAULT_SWEEP_INTERVAL_MS,
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
  /**
   * `peek_hit` / `peek_miss` are reported separately from `hit` / `miss` on
   * purpose. A request-path `peek` miss is a normal, cheap fallback to a
   * default, not a cache failure — folding the two together would make the
   * hit-rate gauge unreadable for any service that uses both.
   */
  onCacheLookup?(
    namespace: string,
    result: "hit" | "miss" | "stale" | "peek_hit" | "peek_miss",
  ): void;
  onResolveDuration?(namespace: string, seconds: number): void;
  onInvalidation?(source: "notify" | "sweep" | "reconnect"): void;
  onEviction?(): void;
  onStaleness?(projectId: string, environment: string, seconds: number): void;
  onListenerUp?(up: boolean): void;
}

export interface ProjectConfigStoreOptions {
  readonly db: Kysely<Database>;
  readonly listener: ListenerTransport;
  readonly logger: Logger;
  readonly capacity?: number;
  readonly sweepIntervalMs?: number;
  readonly now?: () => Date;
  readonly metrics?: ProjectConfigMetricsHooks;
}

export interface ProjectConfigStore {
  get(key: ProjectConfigKey): Promise<ProjectConfigSnapshot>;
  /**
   * Cache-only read. Returns `undefined` on miss and NEVER performs I/O.
   *
   * For request-path callers that cannot afford a possible assembly — the
   * ingester resolves per-project values on every batch, and an inline
   * `get()` would put a database round-trip in ingest p99. Such callers pair
   * this with {@link ProjectConfigStore.warm} at boot and fall back to their
   * own default on a miss.
   *
   * A stale entry is still returned: staleness means "refetch soon", not
   * "unusable", and a request path should never stall on that distinction.
   */
  peek(key: ProjectConfigKey): ProjectConfigSnapshot | undefined;
  /**
   * Resolve and cache the given scopes. Failures are swallowed — a scope that
   * cannot be assembled at boot simply stays cold, and its callers fall back
   * to defaults until it can be.
   */
  warm(keys: readonly ProjectConfigKey[]): Promise<void>;
  pin(keys: readonly ProjectConfigKey[]): Promise<PinnedConfig>;
  invalidate(projectId: string, environment?: PolarisEnvironment): void;
  invalidateAll(): void;
  start(): Promise<void>;
  close(): Promise<void>;
}

interface CacheEntry {
  snapshot: ProjectConfigSnapshot;
  /**
   * Marked by a notification or sweep; the next reader refetches.
   *
   * The only freshness signal an entry has. Secret-bearing entries once
   * carried a second one — a wall-clock deadline that forced re-resolution
   * regardless of version, because a Vault rotation moved no version. Stored
   * secrets change only by a write, and a write bumps the version, so
   * staleness alone now covers them.
   */
  stale: boolean;
  /** Epoch ms this entry's version was last confirmed against the database. */
  confirmedAt: number;
}

export function createProjectConfigStore(options: ProjectConfigStoreOptions): ProjectConfigStore {
  const now = options.now ?? ((): Date => new Date());
  const metrics = options.metrics ?? {};
  const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;

  const cache = new BoundedLru<string, CacheEntry>(
    options.capacity ?? DEFAULT_CACHE_CAPACITY,
    (evictedKey) => {
      // The index must shrink with the cache, or a caller probing many
      // distinct (project, environment, namespace) triples grows it without
      // bound while the LRU stays bounded.
      keyIndex.delete(evictedKey);
      metrics.onEviction?.();
    },
  );
  /** In-flight assemblies, so N concurrent misses issue ONE query. */
  const inFlight = new Map<string, Promise<ProjectConfigSnapshot>>();
  const keyIndex = new Map<string, ProjectConfigKey>();
  /**
   * Versions announced for a scope WHILE an assembly for that scope was in
   * flight. A notification can only mark entries that are already cached, so
   * without this a change committed during a cold assembly is invisible until
   * the sweep: the assembly may have read values before the writer committed,
   * yet caches its snapshot as fresh. Entries are consumed (and removed) when
   * the last in-flight assembly for the scope settles — bounded by the number
   * of concurrent cold assemblies, not by fleet size.
   */
  const notifiedMidAssembly = new Map<string, bigint>();

  let sweepTimer: NodeJS.Timeout | undefined;
  let closed = false;

  function markStale(cacheKey: string): void {
    const entry = cache.peek(cacheKey);
    if (entry !== undefined) entry.stale = true;
  }

  async function assembleInto(cacheKey: string, key: ProjectConfigKey) {
    const pending = inFlight.get(cacheKey);
    if (pending !== undefined) return pending;

    const startedAt = now().getTime();
    const promise = assembleSnapshot({
      db: options.db,
      key,
      now,
    })
      .then((snapshot) => {
        const finishedAt = now().getTime();
        metrics.onResolveDuration?.(key.namespace, (finishedAt - startedAt) / 1000);
        const scope = scopeKey(key.projectId, key.environment);
        const announced = notifiedMidAssembly.get(scope);
        cache.set(cacheKey, {
          snapshot,
          // A write may have committed while this assembly's reads were in
          // flight; its notification could not mark an entry that did not
          // exist yet. Born stale in that case, so the next reader refetches
          // instead of waiting out the sweep.
          stale: announced !== undefined && announced > snapshot.version,
          confirmedAt: finishedAt,
        });
        keyIndex.set(cacheKey, key);
        return snapshot;
      })
      .finally(() => {
        inFlight.delete(cacheKey);
        const scope = scopeKey(key.projectId, key.environment);
        const prefix = `${scope}\0`;
        let scopeStillAssembling = false;
        for (const pendingKey of inFlight.keys()) {
          if (pendingKey.startsWith(prefix)) {
            scopeStillAssembling = true;
            break;
          }
        }
        if (!scopeStillAssembling) notifiedMidAssembly.delete(scope);
      });

    inFlight.set(cacheKey, promise);
    return promise;
  }

  async function get(key: ProjectConfigKey): Promise<ProjectConfigSnapshot> {
    const cacheKey = snapshotKey(key);
    const entry = cache.get(cacheKey);

    if (entry !== undefined && !entry.stale) {
      metrics.onCacheLookup?.(key.namespace, "hit");
      return entry.snapshot;
    }

    metrics.onCacheLookup?.(key.namespace, entry === undefined ? "miss" : "stale");
    // A failed assembly must NOT poison the cache: the entry is only replaced
    // on success, so a database blip means the next read retries.
    return assembleInto(cacheKey, key);
  }

  function peek(key: ProjectConfigKey): ProjectConfigSnapshot | undefined {
    // `cache.peek`, not `cache.get`: a request path touching every project on
    // every batch would otherwise drive LRU recency entirely, and a rarely
    // used namespace read through `get()` would be evicted by traffic it has
    // nothing to do with.
    const cacheKey = snapshotKey(key);
    const entry = cache.peek(cacheKey);
    metrics.onCacheLookup?.(key.namespace, entry === undefined ? "peek_miss" : "peek_hit");
    if (entry === undefined) return undefined;

    // A stale entry is served — a request path never stalls on freshness —
    // but it must also REFRESH, and from here, because for a peek-only
    // caller this is the only code that ever observes the staleness. The
    // ingester reads exclusively through peek: without this kick, a NOTIFY
    // marks the entry stale, every subsequent peek keeps hitting, get() is
    // never called again, and a config change never reaches a running
    // service. Single-flighted, so a burst of peeks schedules one assembly.
    if (entry.stale) {
      void assembleInto(cacheKey, key).catch((err: unknown) => {
        // Next peek retries (the entry is still stale). Warn is bounded by
        // the single-flight: one line per failed assembly, not per peek.
        options.logger.warn(
          {
            component: "project-config.peek",
            project_id: key.projectId,
            environment: key.environment,
            namespace: key.namespace,
            err,
          },
          "background refresh of a stale entry failed; still serving the previous snapshot",
        );
      });
    }
    return entry.snapshot;
  }

  async function warm(keys: readonly ProjectConfigKey[]): Promise<void> {
    await Promise.all(
      keys.map(async (key) => {
        try {
          await get(key);
        } catch (err) {
          // A scope that will not assemble at boot must not stop the service
          // from starting — it stays cold and its callers use defaults, which
          // is §5's fail-soft rule for exactly this case.
          options.logger.warn(
            {
              component: "project-config.warm",
              project_id: key.projectId,
              environment: key.environment,
              namespace: key.namespace,
              err,
            },
            "could not prewarm project config; callers will use defaults until it resolves",
          );
        }
      }),
    );
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
    const scope = scopeKey(message.project_id, message.environment);
    const prefix = `${scope}\0`;
    let touched = false;
    for (const cacheKey of cache.keys()) {
      if (!cacheKey.startsWith(prefix)) continue;
      const entry = cache.peek(cacheKey);
      if (entry === undefined) continue;
      if (message.version <= entry.snapshot.version) continue;
      entry.stale = true;
      touched = true;
    }
    // A cold assembly for this scope cannot be marked — its entry does not
    // exist yet. Remember the announced version so the entry is born stale if
    // the assembly's reads predate this write (see assembleInto).
    for (const pendingKey of inFlight.keys()) {
      if (!pendingKey.startsWith(prefix)) continue;
      const prev = notifiedMidAssembly.get(scope) ?? 0n;
      if (message.version > prev) notifiedMidAssembly.set(scope, message.version);
      break;
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

      // Stale when the version moved forward — OR when it vanished while we
      // hold a written snapshot. A deleted project CASCADEs its versions row
      // away; without the second clause the comparison reads 0 < N as "still
      // fresh" and the fleet serves a dead project's configuration forever.
      const vanished = dbVersion === 0n && entry.snapshot.version > 0n;
      if (dbVersion > entry.snapshot.version || vanished) {
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
    peek,
    warm,
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
