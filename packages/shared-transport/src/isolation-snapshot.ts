/**
 * A periodically-refreshed view of `topic_isolations`, serving both sides.
 *
 * ## Why a snapshot and not the cache
 *
 * `StreamIsolationCache` answers one triple at a time and answers it
 * asynchronously. Neither half fits where the answer is actually needed:
 *
 *   - **Producers** resolve a family on every publish, and
 *     `SyncIsolationLookup.isIsolated` returns `boolean`, not a promise.
 *     The publish path is deliberately synchronous — awaiting PostgreSQL
 *     per message would put a database round trip on the hot path of every
 *     event Polaris ingests.
 *   - **Consumers** need a LIST, once, at subscribe time:
 *     `consumerFamiliesFor(family, projectIds)` builds the subscription set
 *     from it. Asking "is this one project isolated?" cannot enumerate the
 *     projects to subscribe to.
 *
 * So the shape that fits is a set held in memory and refreshed on an
 * interval: synchronous to read, enumerable, and one query per refresh
 * rather than one per message. That is this module.
 *
 * `StreamIsolationCache` remains the right tool for a caller that has a
 * specific triple and can await — the CLI's plan rendering, for instance.
 * This is not a replacement for it.
 *
 * ## Staleness is bounded and one-directional in the dangerous case
 *
 * A snapshot is stale for at most `refreshMs`. What that costs depends on
 * which way it is wrong:
 *
 *   - Newly isolated and not yet seen: the producer keeps publishing to the
 *     shared stream for up to one interval. The consumer subscribes to both
 *     shared and dedicated, so nothing is lost — the events simply arrive
 *     by the old route a little longer. This is why the cutover runbook has
 *     operators provision the dedicated stream and let consumers pick it up
 *     BEFORE traffic moves.
 *   - Newly de-isolated and not yet seen: the producer keeps publishing to
 *     the dedicated stream, which still exists (deisolate does not delete
 *     it) and is still subscribed. Also safe.
 *
 * The unsafe ordering — producing to a stream nobody consumes — is
 * prevented by consumers subscribing to the union rather than switching.
 *
 * ## A failed refresh keeps the last good answer
 *
 * If the control plane is unreachable the snapshot does not empty itself.
 * Emptying would silently move every isolated project's traffic back onto
 * the shared stream, which is a data-routing change caused by a database
 * blip. It logs and keeps serving what it last read; `lastRefreshedAt`
 * exposes the age so a caller can alert on it.
 */

import type { Database } from "@polaris/shared-db";
import type { Logger } from "@polaris/shared-logger";
import type { Kysely } from "kysely";

import type { SyncIsolationLookup } from "./stream-family.js";
import { type CanonicalStreamFamily, isCanonicalStreamFamily } from "./streams.js";

/** One active isolation, as the snapshot needs it. */
export interface ActiveIsolation {
  readonly family: string;
  readonly project_id: string;
}

/**
 * Reads every active isolation for one environment.
 *
 * Environment-scoped rather than global: a service runs in exactly one
 * environment, and loading production's isolations into a development
 * process would route its traffic onto streams that environment does not
 * provision.
 */
export interface IsolationSnapshotReader {
  listActive(environment: string): Promise<ReadonlyArray<ActiveIsolation>>;
}

export interface IsolationSnapshot {
  /** Synchronous lookup for the producer hot path. */
  readonly lookup: SyncIsolationLookup;
  /**
   * Project ids isolated for `family`, for `consumerFamiliesFor`. Returns a
   * fresh array so a caller cannot mutate the snapshot's own state.
   */
  isolatedProjects(family: CanonicalStreamFamily | string): readonly string[];
  /** Read the control plane once, now. Throws only if it has never succeeded. */
  refresh(): Promise<void>;
  /** Begin refreshing on the interval. Idempotent. */
  start(): void;
  /** Stop refreshing. Idempotent; safe to call from a shutdown task. */
  stop(): void;
  /** Epoch ms of the last SUCCESSFUL refresh, or null if there has been none. */
  lastRefreshedAt(): number | null;
}

export interface CreateIsolationSnapshotOptions {
  readonly reader: IsolationSnapshotReader;
  readonly environment: string;
  /** Refresh period. Defaults to 30s — half the cache's default TTL. */
  readonly refreshMs?: number;
  readonly logger?: Logger;
  /** Override the clock for tests. */
  readonly now?: () => number;
}

export function createIsolationSnapshot(
  options: CreateIsolationSnapshotOptions,
): IsolationSnapshot {
  const refreshMs = options.refreshMs ?? 30_000;
  const now = options.now ?? Date.now;

  // family -> set of isolated project ids. Rebuilt wholesale on each
  // refresh: a diff would have to reason about rows that vanished, and the
  // whole set is small enough that replacing it is simpler and atomic.
  let byFamily = new Map<string, ReadonlySet<string>>();
  let lastOk: number | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function refresh(): Promise<void> {
    let rows: ReadonlyArray<ActiveIsolation>;
    try {
      rows = await options.reader.listActive(options.environment);
    } catch (err) {
      // Keep the last good snapshot. See the module header: emptying on a
      // database blip would reroute every isolated project's traffic.
      options.logger?.warn(
        {
          component: "transport.isolation-snapshot",
          environment: options.environment,
          last_refreshed_at: lastOk,
          err: err instanceof Error ? err.message : String(err),
        },
        "isolation snapshot refresh failed; serving the last successful read",
      );
      if (lastOk === null) throw err;
      return;
    }

    const next = new Map<string, Set<string>>();
    for (const row of rows) {
      // A row naming a family this build does not know is a control plane
      // ahead of this binary, or a family retired underneath it. Skipping
      // is right in both directions: `consumerFamiliesFor` throws on a
      // non-canonical family, so passing it through would take the service
      // down at subscribe time over a row it can do nothing with.
      if (!isCanonicalStreamFamily(row.family)) {
        options.logger?.warn(
          { component: "transport.isolation-snapshot", family: row.family },
          "ignoring an isolation row for a family this build does not know",
        );
        continue;
      }
      const set = next.get(row.family) ?? new Set<string>();
      set.add(row.project_id);
      next.set(row.family, set);
    }

    byFamily = next;
    lastOk = now();
  }

  return {
    lookup: {
      isIsolated(family, projectId): boolean {
        return byFamily.get(family)?.has(projectId) ?? false;
      },
    },
    isolatedProjects(family): readonly string[] {
      return [...(byFamily.get(family) ?? [])];
    },
    refresh,
    start(): void {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        void refresh();
      }, refreshMs);
      // Never hold the event loop open for a refresh timer: a service whose
      // work is done should exit, not linger for the next tick.
      timer.unref?.();
    },
    stop(): void {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    },
    lastRefreshedAt: () => lastOk,
  };
}

/**
 * Kysely-backed reader over `topic_isolations`.
 *
 * Lives here rather than in `@polaris/shared-control-plane-db` because
 * `shared-transport` already depends on `@polaris/shared-db` and `kysely`,
 * so this costs no new dependency — while the reverse would put `amqplib`
 * in the tree of every control-plane consumer, including services that
 * deliberately speak to no broker.
 *
 * It also has to be importable from a SERVICE. The equivalent adapter used
 * to live in `apps/polaris-cli`, where no service can reach it, which is a
 * large part of why nothing ever constructed one.
 */
export function createKyselyIsolationSnapshotReader(
  db: Kysely<Database>,
): IsolationSnapshotReader {
  return {
    async listActive(environment): Promise<ReadonlyArray<ActiveIsolation>> {
      const rows = await db
        .selectFrom("topic_isolations")
        .select(["topic_family", "project_id"])
        .where("environment", "=", environment)
        .where("deactivated_at", "is", null)
        .execute();
      return rows.map((row) => ({ family: row.topic_family, project_id: row.project_id }));
    },
  };
}

/**
 * Build, prime and start a snapshot over a Kysely handle — the one call a
 * service bootstrap makes.
 *
 * The first read is awaited and NOT swallowed. A service that booted with
 * an empty snapshot would publish an isolated project's events onto the
 * shared stream and report itself healthy, which is the failure this whole
 * mechanism exists to prevent; and every service that calls this already
 * requires the same database for its checkpoints, so there is no
 * deployment in which the control plane is down and the service is
 * otherwise fine.
 *
 * The caller owns `stop()` — register it with the service's shutdown tasks.
 */
export async function startIsolationSnapshot(options: {
  readonly db: Kysely<Database>;
  readonly environment: string;
  readonly logger?: Logger;
  readonly refreshMs?: number;
}): Promise<IsolationSnapshot> {
  const snapshot = createIsolationSnapshot({
    reader: createKyselyIsolationSnapshotReader(options.db),
    environment: options.environment,
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.refreshMs !== undefined ? { refreshMs: options.refreshMs } : {}),
  });
  await snapshot.refresh();
  snapshot.start();
  return snapshot;
}
