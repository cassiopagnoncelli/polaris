/**
 * The SQL each warehouse dataset exports.
 *
 * This module had no tests at all, which is how three of the six datasets
 * came to be absent: §6.2 asks for "Parquet snapshots of the projection
 * tables and `analytics_raw` slices" and only the fact tables shipped.
 * Nothing could have noticed — an exporter that never runs the projection
 * SELECT is indistinguishable from one that has none.
 *
 * The properties below are the ones that fail SILENTLY when broken, which
 * is the reason to assert them here rather than trust a review:
 *
 *   - **The right dedupe idiom for the engine.** ReplacingMergeTree holds
 *     older VERSIONS between merges (argMax wins); SummingMergeTree holds
 *     ADDENDS (they sum). Applying either idiom to the other's table
 *     returns a number, not an error. A projection exported with argMax
 *     would report one arbitrary partial count as the day's total.
 *   - **No `FINAL`.** Correct, forbidden, and the tempting shortcut.
 *   - **Scoped to one project.** An export is a per-project extract; a
 *     query that could be widened at the call site would be one project's
 *     operator reading another's data through a legitimate verb.
 *   - **Bound parameters, never interpolation.**
 *
 * Driven through `createWarehouseExporter` rather than by exporting
 * `selectFor`: the query that reaches ClickHouse is what matters, and a
 * test of the private builder would still pass if the caller stopped
 * using it.
 */

import { describe, expect, it } from "vitest";

import {
  createWarehouseExporter,
  WAREHOUSE_DATASETS,
  type WarehouseDataset,
} from "../src/warehouse-export.js";

interface CapturedQuery {
  readonly query: string;
  readonly query_params: Record<string, unknown>;
}

/** Stands in for the ClickHouse client, recording what it was asked to run. */
function capturingExporter() {
  const queries: CapturedQuery[] = [];
  const underlying = {
    query: async (args: CapturedQuery) => {
      queries.push(args);
      return { summary: { written_rows: "7", written_bytes: "1024" } };
    },
  } as unknown as Parameters<typeof createWarehouseExporter>[0]["underlying"];
  return { queries, exporter: createWarehouseExporter({ underlying }) };
}

async function sqlFor(dataset: WarehouseDataset): Promise<CapturedQuery> {
  const { queries, exporter } = capturingExporter();
  await exporter.export({
    dataset,
    projectId: "storefront",
    environment: "production",
    day: "2026-08-15",
    target: { bucketUrl: "https://s3.example.com/polaris-warehouse" },
  });
  const captured = queries[0];
  if (captured === undefined) throw new Error(`no query captured for ${dataset}`);
  return captured;
}

/** Which idiom each dataset must use, keyed by its storage engine. */
const REPLACING: readonly WarehouseDataset[] = ["events", "profiles", "merge_map"];
const SUMMING: readonly WarehouseDataset[] = [
  "event_daily_counts",
  "session_daily_metrics",
  "profile_event_daily_counts",
];

describe("every warehouse dataset", () => {
  it("is covered by the two engine groups below", () => {
    // Guards the guard: a seventh dataset added to the constant and to
    // neither list would otherwise be asserted by nothing at all, and this
    // suite would stay green while the new export shipped untested.
    expect([...REPLACING, ...SUMMING].sort()).toEqual([...WAREHOUSE_DATASETS].sort());
  });

  it.each([...WAREHOUSE_DATASETS])("%s never uses FINAL", async (dataset) => {
    const { query } = await sqlFor(dataset);
    expect(query).not.toMatch(/\bFINAL\b/i);
  });

  it.each([...WAREHOUSE_DATASETS])("%s is scoped to one project", async (dataset) => {
    const { query, query_params } = await sqlFor(dataset);
    expect(query).toMatch(/project_id = \{project:String\}/);
    expect(query).toMatch(/environment = \{environment:String\}/);
    expect(query_params["project"]).toBe("storefront");
    expect(query_params["environment"]).toBe("production");
  });

  it.each([...WAREHOUSE_DATASETS])("%s binds values rather than splicing them", async (dataset) => {
    const { query } = await sqlFor(dataset);
    expect(query).not.toContain("storefront");
    expect(query).not.toContain("2026-08-15");
  });
});

describe("the fact tables, on ReplacingMergeTree", () => {
  it.each([...REPLACING])("%s deduplicates with argMax, not sum", async (dataset) => {
    const { query } = await sqlFor(dataset);
    expect(query).toMatch(/argMax\(/);
    expect(query).toMatch(/GROUP BY/);
  });
});

describe("the projections, on SummingMergeTree", () => {
  it.each([...SUMMING])("%s adds its partial rows rather than picking one", async (dataset) => {
    const { query } = await sqlFor(dataset);
    // The distinguishing assertion. argMax here would take one arbitrary
    // partial count and report it as the day's total — a smaller number
    // that looks exactly like a quieter day.
    expect(query).toMatch(/sum\(/);
    expect(query).not.toMatch(/argMax\(/);
    expect(query).toMatch(/GROUP BY/);
  });

  it.each([...SUMMING])("%s reads its own table", async (dataset) => {
    const { query } = await sqlFor(dataset);
    expect(query).toMatch(new RegExp(`FROM\\s+polaris\\.${dataset}\\b`));
    // A projection export that reached for the fact table would be the
    // scan the projections exist to avoid.
    expect(query).not.toMatch(/analytics_raw/);
  });

  it.each([...SUMMING])("%s exports one day, not the whole table", async (dataset) => {
    const { query } = await sqlFor(dataset);
    expect(query).toMatch(/occurred_date = toDate\(\{day:String\}\)/);
  });

  it("keeps profile_event_daily_counts grouped on the table's own sort key", async () => {
    // `customer_id` is not in the sort key, so the engine already holds an
    // arbitrary one of the collapsed values. Grouping BY it would emit
    // more rows than the table logically has whenever a profile's
    // customer_id changed — a snapshot that disagrees with its source.
    const { query } = await sqlFor("profile_event_daily_counts");
    expect(query).toMatch(/any\(customer_id\) AS customer_id/);
    expect(query).toMatch(
      /GROUP BY project_id, environment, profile_id, event, occurred_date/,
    );
  });
});

describe("the object key", () => {
  it.each([...WAREHOUSE_DATASETS])("%s lands under its own prefix", async (dataset) => {
    const { queries, exporter } = capturingExporter();
    const result = await exporter.export({
      dataset,
      projectId: "storefront",
      environment: "production",
      day: "2026-08-15",
      target: { bucketUrl: "https://s3.example.com/polaris-warehouse" },
    });
    expect(queries).toHaveLength(1);
    expect(result.objectUrl).toBe(
      `https://s3.example.com/polaris-warehouse/${dataset}/storefront/production/2026-08-15.parquet`,
    );
  });
});
