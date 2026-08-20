/**
 * `PostgresCheckpointStore` against a real PostgreSQL.
 *
 * This store is the resume point for every Polaris stream consumer — the
 * thing that replaced Kafka's broker-held group offsets. Until this file
 * existed, the unit suite only ever exercised `InMemoryCheckpointStore`,
 * so the SQL, the bigint round trip, and the monotonicity guard were all
 * unverified. A store that silently rewinds is a re-processing incident;
 * one that silently advances is data loss. Neither is something to leave
 * to a hand-run script.
 *
 * The whole file SKIPS unless `POLARIS_INTEGRATION=1` is set, matching
 * the `POLARIS_SMOKE_DOCKER` convention in `tests/smoke/` — the default
 * `pnpm test` on every PR stays hermetic; the integration workflow flips
 * the env var on after bringing up the compose stack.
 *
 * @see libs/bus/src/checkpoints.ts
 * @see db/postgres/migrations/20260810000001_create_transport_checkpoints.sql
 */

import { closeDb, createDb, type Database } from "@polaris/shared-db";
import { PostgresCheckpointStore } from "@polaris/shared-transport";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ENABLED = process.env["POLARIS_INTEGRATION"] === "1";

const POSTGRES = {
  host: process.env["POLARIS_POSTGRES_HOST"] ?? "localhost",
  port: Number(process.env["POLARIS_POSTGRES_PORT"] ?? "5432"),
  database: process.env["POLARIS_POSTGRES_DATABASE"] ?? "polaris",
  user: process.env["POLARIS_POSTGRES_USER"] ?? "polaris",
  password: process.env["POLARIS_POSTGRES_PASSWORD"] ?? "polaris",
  ssl: false,
  poolMax: 4,
} as const;

describe.skipIf(!ENABLED)("PostgresCheckpointStore (integration)", () => {
  let db: Kysely<Database>;
  let store: PostgresCheckpointStore;
  let group: string;

  beforeAll(() => {
    db = createDb({ postgres: POSTGRES });
    store = new PostgresCheckpointStore(db);
    group = `it-${String(Date.now())}`;
  });

  afterAll(async () => {
    await db.deleteFrom("transport_checkpoints").where("group_name", "like", `${group}%`).execute();
    await closeDb(db);
  });

  it("round-trips a position", async () => {
    await store.write({ group_name: group, stream: "raw.events-2", last_offset: "10" });
    expect(await store.read(group, "raw.events-2")).toBe("10");
  });

  it("moves forward", async () => {
    await store.write({ group_name: group, stream: "raw.events-2", last_offset: "25" });
    expect(await store.read(group, "raw.events-2")).toBe("25");
  });

  it("never moves backwards", async () => {
    // A straggler consumer overlapping a newer one (slow pod shutdown)
    // must not rewind it — that is a re-processing incident.
    await store.write({ group_name: group, stream: "raw.events-2", last_offset: "5" });
    expect(await store.read(group, "raw.events-2")).toBe("25");
  });

  it("survives offsets beyond Number.MAX_SAFE_INTEGER", async () => {
    // RabbitMQ stream offsets are unsigned 64-bit. A float round trip
    // here would corrupt the resume point on a long-lived stream.
    await store.write({
      group_name: group,
      stream: "raw.events-3",
      last_offset: "9007199254740993",
    });
    expect(await store.read(group, "raw.events-3")).toBe("9007199254740993");
  });

  it("scopes readAll to one group", async () => {
    await store.write({ group_name: `${group}-other`, stream: "raw.events-2", last_offset: "99" });
    const all = await store.readAll(group);
    expect([...all.entries()].sort()).toEqual([
      ["raw.events-2", "25"],
      ["raw.events-3", "9007199254740993"],
    ]);
  });

  it("derives family and partition consistently with the CHECK constraint", async () => {
    const rows = await db
      .selectFrom("transport_checkpoints")
      .select(["stream", "family", "partition"])
      .where("group_name", "=", group)
      .execute();
    expect(rows.map((r) => `${r.stream}|${r.family}|${r.partition}`).sort()).toEqual([
      "raw.events-2|raw.events|2",
      "raw.events-3|raw.events|3",
    ]);
  });

  it("rejects a name that is not a partition stream", async () => {
    await expect(
      store.write({ group_name: group, stream: "meta-capi.dlq", last_offset: "1" }),
    ).rejects.toThrow(/not a partition stream name/);
  });

  it("advances updated_at, which the stalled-consumer query depends on", async () => {
    const before = await db
      .selectFrom("transport_checkpoints")
      .select("updated_at")
      .where("group_name", "=", group)
      .where("stream", "=", "raw.events-2")
      .executeTakeFirstOrThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await store.write({ group_name: group, stream: "raw.events-2", last_offset: "40" });
    const after = await db
      .selectFrom("transport_checkpoints")
      .select("updated_at")
      .where("group_name", "=", group)
      .where("stream", "=", "raw.events-2")
      .executeTakeFirstOrThrow();
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });
});
