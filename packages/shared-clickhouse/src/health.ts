/**
 * Health/readiness helpers.
 *
 * Pings the underlying `@clickhouse/client` and surfaces a small structured
 * result that callers can shape into their own `/healthz` / `/readyz`
 * responses. The package does not own the HTTP layer; it just makes the
 * outcome easy to consume.
 */

import type { ClickHouseClient as UnderlyingClickHouseClient } from "@clickhouse/client";
import { runQuery } from "./internal/exec.js";
import type { HealthCheckResult } from "./types.js";

export interface HealthChecker {
  /** Lightweight `SELECT 1`. Cheap; safe to call from a readiness probe. */
  check(): Promise<HealthCheckResult>;
  /** Returns the ClickHouse server version. Slightly heavier; for `/info`-style routes. */
  serverVersion(): Promise<string>;
}

export function createHealthChecker(input: {
  underlying: UnderlyingClickHouseClient;
}): HealthChecker {
  const { underlying } = input;

  return {
    async check() {
      const start = process.hrtime.bigint();
      try {
        await runQuery<{ ok: number }>({
          underlying,
          query: "SELECT 1 AS ok",
        });
        const latencyMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
        return {
          healthy: true,
          latencyMs,
        };
      } catch (cause) {
        return {
          healthy: false,
          error: cause instanceof Error ? cause.message : String(cause),
        };
      }
    },
    async serverVersion() {
      const rows = await runQuery<{ version: string }>({
        underlying,
        query: "SELECT version() AS version",
      });
      const first = rows[0];
      if (!first) {
        return "unknown";
      }
      return first.version;
    },
  };
}
