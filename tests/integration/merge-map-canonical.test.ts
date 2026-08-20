/**
 * The merge map, end to end against a live ClickHouse.
 *
 * The unit tests prove `buildMergeRows` collapses chains. What they cannot
 * prove is the half that actually matters to a reader: that
 * `dictGetOrDefault('polaris.profile_canonical', ...)` returns the survivor
 * for a merged profile and the profile ITSELF for one that was never merged.
 * Both halves have to hold or the query pattern documented in
 * `07-clickhouse.md` is wrong for half the rows in the warehouse.
 *
 * The whole file SKIPS unless `POLARIS_INTEGRATION=1`, matching the other
 * files here — the default `pnpm test` stays Docker-free.
 *
 * Requires the schema in `db/clickhouse/34_profile_merge_map.sql` to be
 * applied (`node scripts/clickhouse-migrate.mjs`).
 */

import { type ClickHouseOperatorClient, createClickHouseClient } from "@polaris/persistence-clickhouse";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ENABLED = process.env["POLARIS_INTEGRATION"] === "1";
const describeIf = ENABLED ? describe : describe.skip;

const PROJECT = "integration-merge-map";
const ENVIRONMENT = "development";

const A = "0193a000-0000-7000-8000-00000000000a";
const B = "0193b000-0000-7000-8000-00000000000b";
const C = "0193c000-0000-7000-8000-00000000000c";
/** Never merged. The `OrDefault` half of the contract. */
const LONER = "0193f000-0000-7000-8000-00000000000f";

describeIf("profile_canonical dictionary", () => {
  // The OPERATOR client, named explicitly: `raw.query` is the audited escape
  // hatch, and a dictionary reload has no typed wrapper. The service role
  // does not carry `raw` at all, which is the package doing its job.
  let client: ClickHouseOperatorClient;

  beforeAll(async () => {
    client = createClickHouseClient({
      url: process.env["POLARIS_CLICKHOUSE_URL"] ?? "http://localhost:8123",
      role: "operator",
      credential: {
        username: process.env["POLARIS_CLICKHOUSE_OPERATOR_USER"] ?? "default",
        password: process.env["POLARIS_CLICKHOUSE_OPERATOR_PASSWORD"] ?? "",
      },
      database: "polaris",
      application: "merge-map-integration",
    });
  });

  afterAll(async () => {
    await client.close();
  });

  async function canonicalOf(profileId: string): Promise<string> {
    // Exactly the expression `docs/architecture/07-clickhouse.md` tells
    // analysts to write. If this test and that document ever disagree, one
    // of them is lying to somebody.
    const result = await client.raw.query<{ canonical: string }>(
      `SELECT dictGetOrDefault(
                'polaris.profile_canonical',
                'winner_profile_id',
                ({project:String}, {environment:String}, {profile:UUID}),
                {profile:UUID}
              ) AS canonical`,
      { project: PROJECT, environment: ENVIRONMENT, profile: profileId },
      { caller: "merge-map-integration", reason: "verify canonical resolution" },
    );
    return result.rows[0]?.canonical ?? "";
  }

  it("resolves a merged profile to its survivor, and an unmerged one to itself", async () => {
    await client.mergeMap.upsert([
      {
        project_id: PROJECT,
        environment: ENVIRONMENT,
        loser_profile_id: A,
        winner_profile_id: B,
        merge_id: "0193d000-0000-7000-8000-00000000000d",
        reason: "integration",
        merged_at: "2026-08-14T12:00:00.000Z",
        _version: Date.parse("2026-08-14T12:00:00.000Z"),
      },
    ]);
    // The dictionary's LIFETIME is 30-60s; force a reload rather than sleep.
    await client.raw.query(
      "SYSTEM RELOAD DICTIONARY polaris.profile_canonical",
      {},
      { caller: "merge-map-integration", reason: "force dictionary reload" },
    );

    expect(await canonicalOf(A)).toBe(B);
    // The `OrDefault` half. A profile absent from the dictionary must come
    // back as itself, or every query would need to know whether the person
    // it is asking about has ever been merged.
    expect(await canonicalOf(LONER)).toBe(LONER);
  });

  it("resolves a chain in ONE lookup", async () => {
    // The failure this design exists to prevent: a dictionary cannot
    // iterate, so if the map stored A->B and B->C as emitted, this returns
    // B and the query under-merges silently.
    await client.mergeMap.upsert([
      {
        project_id: PROJECT,
        environment: ENVIRONMENT,
        loser_profile_id: B,
        winner_profile_id: C,
        merge_id: "0193e000-0000-7000-8000-00000000000e",
        reason: "integration chain",
        merged_at: "2026-08-22T09:00:00.000Z",
        _version: Date.parse("2026-08-22T09:00:00.000Z"),
      },
      {
        // The transitive rewrite the worker performs.
        project_id: PROJECT,
        environment: ENVIRONMENT,
        loser_profile_id: A,
        winner_profile_id: C,
        merge_id: "0193d000-0000-7000-8000-00000000000d",
        reason: "integration",
        merged_at: "2026-08-22T09:00:00.000Z",
        _version: Date.parse("2026-08-22T09:00:00.000Z"),
      },
    ]);
    await client.raw.query(
      "SYSTEM RELOAD DICTIONARY polaris.profile_canonical",
      {},
      { caller: "merge-map-integration", reason: "force dictionary reload" },
    );

    expect(await canonicalOf(A)).toBe(C);
    expect(await canonicalOf(B)).toBe(C);
  });

  it("reads the chain a new merge invalidates", async () => {
    const chained = await client.mergeMap.chainedInto({
      projectId: PROJECT,
      environment: ENVIRONMENT,
      profileId: C,
    });
    expect(chained.map((entry) => entry.loser_profile_id).sort()).toEqual([A, B].sort());
  });
});
