/**
 * Postgres readiness probe.
 *
 * `/ready` previously reported ready with an empty probe list, because
 * `server.ts` called `buildControlPlaneApp({ config })` without any
 * `readinessProbes` — so a control plane whose database was unreachable still
 * told the load balancer it was fine. Tolerable when the only route was
 * `/v1/whoami`, which touches Postgres only for bearer auth. Actively
 * misleading once every admin page is a query: without this, a dead pool
 * reports as "the UI is broken" rather than "this instance is not ready".
 *
 * Built where the pool is owned (`app.ts`) rather than in `server.ts`, so
 * every caller gets it rather than only the binary.
 */

import type { Database } from "@polaris/persistence-postgres";
import type { ReadinessProbe } from "@polaris/runtime-service-bootstrap";
import { type Kysely, sql } from "kysely";

/** Keep well under the bootstrap's 1s probe budget. */
const PROBE_TIMEOUT_MS = 2_000;

export function createPostgresReadinessProbe(db: Kysely<Database>): ReadinessProbe {
  return async function postgresProbe() {
    const startedAt = Date.now();
    try {
      await withTimeout(sql`SELECT 1`.execute(db), PROBE_TIMEOUT_MS);
      return { name: "postgres", status: "up", latencyMs: Date.now() - startedAt };
    } catch (err) {
      return {
        name: "postgres",
        status: "down",
        // Short by design — this lands in a JSON body scrapers read.
        detail: err instanceof Error ? err.message.slice(0, 200) : "query failed",
        latencyMs: Date.now() - startedAt,
      };
    }
  };
}

/**
 * A hung connection attempt would otherwise hold `/ready` open past any
 * sensible probe deadline, which reads as a timeout rather than a clear
 * "down".
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`probe timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
