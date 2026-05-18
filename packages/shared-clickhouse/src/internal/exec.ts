/**
 * Thin execution helper around `@clickhouse/client`.
 *
 * The point of this helper is twofold:
 *   1. Translate the underlying client's errors into our typed
 *      `ClickHouseQueryError` so call sites don't import the underlying
 *      error types.
 *   2. Centralise the format choice (`JSONEachRow`) so every typed reader
 *      shares one path through the wire format. This keeps the row-shape
 *      decoding tests in one place.
 */

import type { ClickHouseClient as UnderlyingClickHouseClient } from "@clickhouse/client";
import { ClickHouseQueryError } from "../errors.js";

export interface RunQueryInput<TRow> {
  underlying: UnderlyingClickHouseClient;
  query: string;
  parameters?: Record<string, unknown>;
  /** Optional abort signal for callers that wire request timeouts. */
  abortSignal?: AbortSignal;
  /** Optional decoder. Defaults to identity. */
  decode?: (row: unknown) => TRow;
  /**
   * Optional `query_id` forwarded to the underlying ClickHouse
   * client. ClickHouse tags the query with this id in
   * `system.query_log` so callers can look up `written_rows` for
   * INSERTs that don't return rows in their response body.
   */
  queryId?: string;
}

export async function runQuery<TRow = Record<string, unknown>>(
  input: RunQueryInput<TRow>,
): Promise<TRow[]> {
  const { underlying, query, parameters, abortSignal, decode, queryId } = input;
  try {
    const result = await underlying.query({
      query,
      format: "JSONEachRow",
      ...(parameters ? { query_params: parameters } : {}),
      ...(abortSignal ? { abort_signal: abortSignal } : {}),
      ...(queryId !== undefined ? { query_id: queryId } : {}),
    });
    const rows = (await result.json()) as unknown[];
    return decode ? rows.map(decode) : (rows as TRow[]);
  } catch (cause) {
    throw new ClickHouseQueryError(extractMessage(cause), { cause });
  }
}

function extractMessage(cause: unknown): string {
  if (cause instanceof Error) {
    return `ClickHouse query failed: ${cause.message}`;
  }
  return "ClickHouse query failed with non-Error cause.";
}
