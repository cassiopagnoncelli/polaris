/**
 * Golden results for `orders_30d`, against a live ClickHouse.
 *
 * A checked-in expected-output file would test my transcription of the SQL,
 * not the SQL. This seeds known rows into `event_daily_counts`, runs the
 * REAL definition from `definitions/traits/`, and asserts the exact
 * `(profile_id, value)` output — including the boundaries, which is where a
 * window query goes wrong quietly:
 *
 *   - day 30 is inside the window, day 31 is not;
 *   - rows with a NULL profile_id are excluded, not counted as a group;
 *   - a profile whose count sums to zero is absent, not present with 0.
 *
 * The whole file SKIPS unless `POLARIS_INTEGRATION=1`, matching its
 * neighbours — the default `pnpm test` stays Docker-free.
 */

import { type ClickHouseOperatorClient, createClickHouseClient } from "@polaris/persistence-clickhouse";
import { ordersThirtyDays } from "@polaris/trait-catalog";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ENABLED = process.env["POLARIS_INTEGRATION"] === "1";
const describeIf = ENABLED ? describe : describe.skip;

const PROJECT = "integration-traits";
const ENVIRONMENT = "development";

const RECENT = "01930000-0000-7000-8000-0000000000a1";
const BOUNDARY_IN = "01930000-0000-7000-8000-0000000000a2";
const BOUNDARY_OUT = "01930000-0000-7000-8000-0000000000a3";
const OTHER_EVENT = "01930000-0000-7000-8000-0000000000a4";

describeIf("orders_30d golden results", () => {
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
      application: "traits-golden",
    });

    await client.raw.query(
      `INSERT INTO polaris.event_daily_counts
         (project_id, environment, day, event, profile_id, event_count)
       VALUES
         ({project:String}, {env:String}, today() - 1,  'order.completed', {recent:UUID},   3),
         ({project:String}, {env:String}, today() - 5,  'order.completed', {recent:UUID},   2),
         ({project:String}, {env:String}, today() - 30, 'order.completed', {inWin:UUID},    1),
         ({project:String}, {env:String}, today() - 31, 'order.completed', {outWin:UUID},   9),
         ({project:String}, {env:String}, today() - 2,  'page.viewed',     {other:UUID},    7)`,
      {
        project: PROJECT,
        env: ENVIRONMENT,
        recent: RECENT,
        inWin: BOUNDARY_IN,
        outWin: BOUNDARY_OUT,
        other: OTHER_EVENT,
      },
      { caller: "traits-golden", reason: "seed fixture rows" },
    );
  });

  afterAll(async () => {
    await client.raw.query(
      `ALTER TABLE polaris.event_daily_counts DELETE
         WHERE project_id = {project:String} AND environment = {env:String}`,
      { project: PROJECT, env: ENVIRONMENT },
      { caller: "traits-golden", reason: "clean fixture rows" },
    );
    await client.close();
  });

  it("produces exactly the expected rows", async () => {
    const result = await client.traitQuery.run({
      // The REAL definition, imported rather than retyped. A copy here would
      // pass while the shipped SQL was wrong.
      sql: ordersThirtyDays.sql,
      projectId: PROJECT,
      environment: ENVIRONMENT,
    });

    const byProfile = Object.fromEntries(result.map((r) => [r.profile_id, r.value]));

    // Two days summed into one value.
    expect(byProfile[RECENT]).toBe(5);
    // Day 30 is INSIDE the window — `>= today() - 30`.
    expect(byProfile[BOUNDARY_IN]).toBe(1);
    // Day 31 is outside it. Off-by-one here would silently widen every
    // trait's window by a day for every project.
    expect(byProfile[BOUNDARY_OUT]).toBeUndefined();
    // A different event does not count toward orders.
    expect(byProfile[OTHER_EVENT]).toBeUndefined();
    expect(result).toHaveLength(2);
  });

  it("excludes rows with no profile, rather than grouping them", async () => {
    // Pre-spine history carries no profile_id. Grouping those under a single
    // NULL would invent a customer with everyone's orders.
    await client.raw.query(
      `INSERT INTO polaris.event_daily_counts
         (project_id, environment, day, event, profile_id, event_count)
       VALUES ({project:String}, {env:String}, today(), 'order.completed', NULL, 100)`,
      { project: PROJECT, env: ENVIRONMENT },
      { caller: "traits-golden", reason: "seed a pre-spine row" },
    );

    const result = await client.traitQuery.run({
      sql: ordersThirtyDays.sql,
      projectId: PROJECT,
      environment: ENVIRONMENT,
    });
    expect(result.some((r) => r.profile_id === null)).toBe(false);
    expect(result.every((r) => typeof r.value === "number" && r.value > 0)).toBe(true);
  });

  it("returns nothing for a project with no orders", async () => {
    // Absent, not zero. The runner writes absence as a REMOVAL, and a query
    // that returned zeros would have it write zeros instead — making "no
    // orders" indistinguishable from "never computed".
    const result = await client.traitQuery.run({
      sql: ordersThirtyDays.sql,
      projectId: "integration-traits-empty",
      environment: ENVIRONMENT,
    });
    expect(result).toEqual([]);
  });
});
