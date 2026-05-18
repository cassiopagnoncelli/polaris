/**
 * Behavioural tests for `createPartsReader` (U342CPX9).
 *
 * Synthetic `OperatorRaw` mock; assertions are on the SQL string, the
 * parameter bindings (NEVER interpolation of table/range into SQL),
 * and the audit context the reader stamps. Coverage:
 *
 *   - full-table probe (fromTs = toTs = null) → empty-string
 *     sentinels in the `from` / `to` parameters, range predicate
 *     short-circuits in SQL,
 *   - bounded-range probe → both bounds bound as ISO strings,
 *   - response mapping → `partition` + `rowsEstimated` round-trip,
 *     including numeric coercion when the driver returns row counts
 *     as strings (ClickHouse's HTTP JSON encodes UInt64 as string by
 *     default),
 *   - caller/reason propagated; reason differs for full vs ranged,
 *   - malformed `qualifiedTable` (no dot, or wrong database prefix)
 *     fails before the raw.query call.
 *
 * @see packages/shared-clickhouse/src/rebuild/parts-reader.ts
 */

import { describe, expect, it } from "vitest";

import type { OperatorRaw } from "../src/raw.js";
import { createPartsReader, REBUILD_PARTS_READER_CALLER } from "../src/rebuild/index.js";

interface RecordedCall {
  readonly sql: string;
  readonly parameters: Record<string, unknown>;
  readonly caller: string;
  readonly reason: string;
}

function makeRaw<TRow extends Record<string, unknown> = Record<string, unknown>>(
  rows: TRow[],
): {
  readonly raw: OperatorRaw;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  return {
    raw: {
      // biome-ignore lint/suspicious/noExplicitAny: synthetic stub
      async query(sql, parameters, context): Promise<any> {
        calls.push({
          sql,
          parameters: { ...parameters },
          caller: context.caller,
          reason: context.reason,
        });
        return { rows, rowCount: rows.length, query: sql };
      },
    },
    calls,
  };
}

const TABLE = "polaris.event_daily_counts";

describe("createPartsReader", () => {
  it("full-table probe: binds empty-string sentinels and stamps a 'full' reason", async () => {
    const { raw, calls } = makeRaw([
      { partition: "202604", rows_estimated: 10_000 },
      { partition: "202605", rows_estimated: 25_000 },
    ]);
    const reader = createPartsReader({ raw, database: "polaris" });
    const result = await reader({
      qualifiedTable: TABLE,
      fromTs: null,
      toTs: null,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.parameters).toEqual({
      db: "polaris",
      tbl: "event_daily_counts",
      from: "",
      to: "",
    });
    expect(calls[0]?.caller).toBe(REBUILD_PARTS_READER_CALLER);
    expect(calls[0]?.reason).toBe(`plan ${TABLE} full`);
    // Sanity: the table name reached the SQL as a parameter, NOT
    // interpolated. The placeholder must appear literally.
    expect(calls[0]?.sql).toContain("{tbl:String}");
    expect(calls[0]?.sql).not.toContain("event_daily_counts");
    expect(result.partitions).toEqual([
      { partition: "202604", rowsEstimated: 10_000 },
      { partition: "202605", rowsEstimated: 25_000 },
    ]);
  });

  it("bounded-range probe: binds ISO strings for both bounds and stamps from/to in the reason", async () => {
    const { raw, calls } = makeRaw([{ partition: "202604", rows_estimated: 7 }]);
    const reader = createPartsReader({ raw, database: "polaris" });
    const from = new Date("2026-04-01T00:00:00.000Z");
    const to = new Date("2026-05-01T00:00:00.000Z");
    await reader({
      qualifiedTable: TABLE,
      fromTs: from,
      toTs: to,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.parameters).toEqual({
      db: "polaris",
      tbl: "event_daily_counts",
      from: from.toISOString(),
      to: to.toISOString(),
    });
    expect(calls[0]?.reason).toBe(
      `plan ${TABLE} from=${from.toISOString()} to=${to.toISOString()}`,
    );
    expect(calls[0]?.caller).toBe(REBUILD_PARTS_READER_CALLER);
  });

  it("string-encoded row counts: numeric coercion happens in the reader, not the caller", async () => {
    // ClickHouse's HTTP JSON encodes UInt64 as a string by default
    // (`output_format_json_quote_64bit_integers = 1`). The reader
    // coerces so the planner sees a real number.
    const { raw } = makeRaw([
      { partition: "202604", rows_estimated: "999999999999" },
      { partition: "202605", rows_estimated: 17 },
    ]);
    const reader = createPartsReader({ raw, database: "polaris" });
    const result = await reader({
      qualifiedTable: TABLE,
      fromTs: null,
      toTs: null,
    });
    expect(result.partitions[0]?.rowsEstimated).toBe(999_999_999_999);
    expect(typeof result.partitions[0]?.rowsEstimated).toBe("number");
    expect(result.partitions[1]?.rowsEstimated).toBe(17);
  });

  it("empty result: returns zero partitions without throwing", async () => {
    const { raw } = makeRaw<{ partition: string; rows_estimated: number }>([]);
    const reader = createPartsReader({ raw, database: "polaris" });
    const result = await reader({
      qualifiedTable: TABLE,
      fromTs: null,
      toTs: null,
    });
    expect(result.partitions).toEqual([]);
  });

  it("malformed qualifiedTable (no dot): refuses before issuing any SQL", async () => {
    const { raw, calls } = makeRaw([]);
    const reader = createPartsReader({ raw, database: "polaris" });
    await expect(
      reader({
        qualifiedTable: "event_daily_counts",
        fromTs: null,
        toTs: null,
      }),
    ).rejects.toThrow(/clickhouse_rebuild_parts_reader_malformed_table/);
    expect(calls).toHaveLength(0);
  });

  it("database mismatch: refuses before issuing any SQL", async () => {
    const { raw, calls } = makeRaw([]);
    const reader = createPartsReader({ raw, database: "polaris" });
    await expect(
      reader({
        qualifiedTable: "other.event_daily_counts",
        fromTs: null,
        toTs: null,
      }),
    ).rejects.toThrow(/clickhouse_rebuild_parts_reader_database_mismatch/);
    expect(calls).toHaveLength(0);
  });

  it("SQL shape: query targets system.parts with the active = 1 filter and groups by partition", async () => {
    const { raw, calls } = makeRaw([]);
    const reader = createPartsReader({ raw, database: "polaris" });
    await reader({ qualifiedTable: TABLE, fromTs: null, toTs: null });
    const sql = calls[0]?.sql ?? "";
    expect(sql).toContain("FROM system.parts");
    expect(sql).toContain("active = 1");
    expect(sql).toContain("GROUP BY partition");
    expect(sql).toContain("ORDER BY partition");
    // sum() rather than count() — partitions can have multiple parts
    // each with their own rows; the planner needs the per-partition
    // total.
    expect(sql).toContain("sum(rows)");
  });
});
