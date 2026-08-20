/**
 * Operator escape hatch.
 *
 * `operator.raw.query(sql, params, context)` is the only path through this
 * package that allows arbitrary SQL against `polaris.*`, including
 * `analytics_raw` and ad-hoc `SETTINGS final = 1` queries.
 *
 * Every call emits:
 *   - A metric: `polaris_clickhouse_operator_raw_query_total{caller=...}`
 *   - A structured log line at level `info` with `caller`, `reason`,
 *     `ticket`, `queryDigest`, and the row count.
 *
 * Callers MUST supply `caller` and `reason` (see
 * `ClickHouseEscapeHatchUnauthorizedError`). The audit trail is the point
 * of the escape hatch; if you can suppress the trail, the hatch becomes
 * the normal path, which is exactly what the architecture forbids.
 */

import { createHash } from "node:crypto";
import type { ClickHouseClient as UnderlyingClickHouseClient } from "@clickhouse/client";
import { ClickHouseEscapeHatchUnauthorizedError } from "./errors.js";
import { runQuery } from "./internal/exec.js";
import type { Logger, MetricsRecorder, RawQueryContext, RawQueryResult } from "./types.js";

export const ESCAPE_HATCH_METRIC = "polaris_clickhouse_operator_raw_query_total";

export interface OperatorRaw {
  /**
   * Run arbitrary SQL against ClickHouse under the operator profile.
   *
   * @param sql       The SQL to run. The caller is responsible for using
   *                  ClickHouse parameter syntax (`{name:Type}`) plus the
   *                  `parameters` map for variable bindings. Inline string
   *                  interpolation is the caller's risk.
   * @param parameters Named parameter bindings, mapped by ClickHouse's
   *                  `query_params` mechanism. Empty object is OK.
   * @param context   Audit context. `caller` and `reason` are required so
   *                  every escape-hatch call is traceable.
   */
  query<TRow = Record<string, unknown>>(
    sql: string,
    parameters: Record<string, unknown>,
    context: RawQueryContext,
  ): Promise<RawQueryResult<TRow>>;
}

export interface CreateOperatorRawInput {
  underlying: UnderlyingClickHouseClient;
  logger?: Logger;
  metrics?: MetricsRecorder;
}

export function createOperatorRaw(input: CreateOperatorRawInput): OperatorRaw {
  const { underlying, logger, metrics } = input;

  return {
    async query(sql, parameters, context) {
      assertContext(context);
      const queryDigest = sha256Short(sql);
      const startNs = process.hrtime.bigint();

      // Emit the metric BEFORE running the query. We want the audit signal
      // even when the query fails — operators reviewing usage need to see
      // attempted escape-hatch calls, not just successful ones.
      try {
        metrics?.incrementCounter(ESCAPE_HATCH_METRIC, {
          caller: context.caller,
        });
      } catch {
        // Metrics emission failures must never block a query. Fall through.
      }

      logger?.info(
        {
          event: "clickhouse.operator.raw.query",
          caller: context.caller,
          reason: context.reason,
          ticket: context.ticket,
          queryId: context.queryId,
          queryDigest,
          parameterKeys: Object.keys(parameters).sort(),
        },
        "operator escape-hatch invoked",
      );

      try {
        const rows = await runQuery<Record<string, unknown>>({
          underlying,
          query: sql,
          parameters,
          ...(context.queryId !== undefined ? { queryId: context.queryId } : {}),
        });
        const durationMs = Number((process.hrtime.bigint() - startNs) / 1_000_000n);
        logger?.info(
          {
            event: "clickhouse.operator.raw.query.result",
            caller: context.caller,
            queryDigest,
            rowCount: rows.length,
            durationMs,
          },
          "operator escape-hatch completed",
        );
        // biome-ignore lint/suspicious/noExplicitAny: cast through unknown to caller-supplied row generic.
        return { rows: rows as any, rowCount: rows.length, query: sql };
      } catch (cause) {
        logger?.error(
          {
            event: "clickhouse.operator.raw.query.error",
            caller: context.caller,
            queryDigest,
            error: cause instanceof Error ? cause.message : String(cause),
          },
          "operator escape-hatch failed",
        );
        throw cause;
      }
    },
  };
}

function assertContext(context: RawQueryContext): void {
  if (!context.caller || context.caller.trim() === "") {
    throw new ClickHouseEscapeHatchUnauthorizedError(
      "operator.raw.query requires `context.caller`. The escape hatch must leave an audit trail.",
    );
  }
  if (!context.reason || context.reason.trim() === "") {
    throw new ClickHouseEscapeHatchUnauthorizedError(
      "operator.raw.query requires `context.reason`. Document why arbitrary SQL is needed.",
    );
  }
}

/**
 * Short SHA-256 digest for logging. The full SQL is also logged; the digest
 * gives operators a stable correlation token across log lines.
 */
function sha256Short(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}
