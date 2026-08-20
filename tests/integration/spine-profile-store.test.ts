/**
 * The spine's profile-store access, against a real PostgreSQL.
 *
 * R1B and R1C both shipped their behavioural suites against in-memory
 * twins held to the same contract, which covers every property that is
 * a function of the data. It cannot cover the two that are functions of
 * PostgreSQL: lock ordering, and what two transactions do to each other.
 * Those are exactly where this code is load-bearing —
 *
 *   - the identity stage is the profile store's ONLY writer, and its
 *     whole job is to make concurrent events about one person converge
 *     on one profile;
 *   - the enrichment stage reads what that writer committed, and the
 *     commit-before-publish invariant is the reason it needs no
 *     read-your-writes machinery.
 *
 * A twin that models "find or create" as a Map lookup passes both no
 * matter what the SQL does. This file is where those claims meet a
 * database that can actually deadlock, block, and lose updates.
 *
 * SKIPS unless `POLARIS_INTEGRATION=1`, matching the convention in
 * `transport-checkpoints.test.ts`: the default `pnpm test` on every PR
 * stays hermetic, and the integration workflow flips the var on after
 * bringing the compose stack up.
 *
 * @see sync/identity/resolver/v1/src/repository.ts
 * @see sync/enrichment/traits/v1/src/reader.ts
 * @see db/postgres/migrations/20260814000001_create_profile_plane.sql
 */

import { closeDb, createDb, type Database } from "@polaris/shared-db";
import { createKyselyProfileReader } from "@polaris/sync-enrichment-traits-v1";
import { createKyselyProfileRepository } from "@polaris/sync-identity-resolver-v1";
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
  // Several of these tests run two transactions at once ON PURPOSE, so
  // the pool has to be able to hold both open simultaneously. A pool of
  // 1 would turn every concurrency test into a false pass by
  // serialising the callers before they reach the database.
  poolMax: 8,
} as const;

const PROJECT = "storefront";
const ENVIRONMENT = "development";

const POLICY = {
  denylist: {},
  maxIdentifiersPerKind: 100,
  maxMergesPerWindow: 50,
  mergeWindowSeconds: 3600,
  maxTraitsBytes: 32_768,
} as const;

/** Unique per run, so a failed run never poisons the next one. */
let runTag: string;
let seq = 0;
function ident(kind: "customer_id" | "anonymous_id", label: string) {
  return { kind, value: `${runTag}-${label}` };
}
function eventId(): string {
  seq += 1;
  return `019ffe00-0000-7000-8000-${String(seq).padStart(12, "0")}`;
}

function resolveInput(
  identifiers: ReadonlyArray<{ kind: "customer_id" | "anonymous_id"; value: string }>,
  extra: Partial<{ traits: Record<string, unknown> | null }> = {},
) {
  return {
    projectId: PROJECT,
    environment: ENVIRONMENT,
    identifiers,
    traits: extra.traits ?? null,
    sourceEventId: eventId(),
    sourceEventName: "page.viewed",
    runId: null,
    policy: POLICY,
    now: new Date(),
  };
}

describe.skipIf(!ENABLED)("spine profile store (integration)", () => {
  let db: Kysely<Database>;

  beforeAll(async () => {
    db = createDb({ postgres: POSTGRES });
    runTag = `it${String(Date.now())}`;
    // The project must exist: `profiles.project_id` carries an FK.
    const existing = await db
      .selectFrom("projects")
      .select("project_id")
      .where("project_id", "=", PROJECT)
      .executeTakeFirst();
    expect(
      existing,
      `integration tests need the '${PROJECT}' project; run \`polaris projects sync\``,
    ).toBeDefined();
  });

  afterAll(async () => {
    // Identifier rows first — they reference profiles.
    await db.deleteFrom("profile_identifiers").where("value", "like", `${runTag}%`).execute();
    const ours = await db
      .selectFrom("profiles")
      .select("profile_id")
      .where("canonical_customer_id", "like", `${runTag}%`)
      .execute();
    const ids = ours.map((row) => row.profile_id);
    if (ids.length > 0) {
      await db.deleteFrom("profile_merges").where("winner_profile_id", "in", ids).execute();
      await db.deleteFrom("profile_merges").where("loser_profile_id", "in", ids).execute();
      // `merged_into` is a self-FK, so break the links before deleting.
      await db
        .updateTable("profiles")
        .set({ merged_into: null })
        .where("profile_id", "in", ids)
        .execute();
      await db.deleteFrom("profiles").where("profile_id", "in", ids).execute();
    }
    await db.deleteFrom("identity_links").where("left_identifier", "like", `%${runTag}%`).execute();
    await closeDb(db);
  });

  describe("find-or-create under concurrency", () => {
    it("converges simultaneous first-sightings onto ONE profile, with no orphan", async () => {
      // THE property the profile store exists for, and the one this
      // suite was written to catch: `SELECT ... FOR UPDATE` locks the
      // rows it FINDS, which is nothing at all on an identifier nobody
      // has bound yet. Before the advisory lock, concurrent workers each
      // saw "no match", each inserted a `profiles` row, and the
      // identifier's primary key let only one of them own it — so the
      // loser returned a profile id with no identifier pointing at it
      // and stamped that orphan onto the spine.
      //
      // Asserting only "the identifier resolves to one profile" would
      // NOT have caught it: the primary key guarantees that much on its
      // own. The orphan count is the assertion that bites.
      const repo = createKyselyProfileRepository(db);
      const identifiers = [ident("customer_id", "race-a")];
      const WORKERS = 6;

      const results = await Promise.all(
        Array.from({ length: WORKERS }, () => repo.resolveProfile(resolveInput(identifiers))),
      );

      const distinct = new Set(results.map((r) => r.profileId));
      expect(distinct.size, "every worker must agree on one profile id").toBe(1);
      const winner = results[0]?.profileId as string;
      expect(winner).not.toBeNull();

      const bound = await db
        .selectFrom("profile_identifiers")
        .select(["profile_id"])
        .where("project_id", "=", PROJECT)
        .where("environment", "=", ENVIRONMENT)
        .where("value", "=", identifiers[0]?.value as string)
        .execute();
      expect(bound).toHaveLength(1);
      expect(bound[0]?.profile_id).toBe(winner);

      // No orphans: exactly one profile row was created for this
      // identifier, not one per racing worker.
      const created = await db
        .selectFrom("profiles")
        .select(["profile_id"])
        .where("canonical_customer_id", "=", identifiers[0]?.value as string)
        .execute();
      expect(created, "a losing worker must not leave an unreferenced profile").toHaveLength(1);
    });

    it("converges when the racing events carry DIFFERENT identifier sets", async () => {
      // The subtler shape: one worker sees only the anonymous id while
      // another sees anonymous + customer. They overlap on one
      // identifier, so they must still land on one person — and the
      // advisory locks are taken in canonical order, so the overlapping
      // pair queues instead of deadlocking.
      const repo = createKyselyProfileRepository(db);
      const anon = ident("anonymous_id", "race-mixed-anon");
      const cust = ident("customer_id", "race-mixed-cust");

      const [a, b, c] = await Promise.all([
        repo.resolveProfile(resolveInput([anon])),
        repo.resolveProfile(resolveInput([anon, cust])),
        repo.resolveProfile(resolveInput([cust])),
      ]);

      // Whatever order they interleaved in, both identifiers end up
      // pointing at the same person once the dust settles.
      const rows = await db
        .selectFrom("profile_identifiers")
        .select(["profile_id"])
        .where("value", "in", [anon.value, cust.value])
        .execute();
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.profile_id)).size).toBe(1);
      for (const result of [a, b, c]) expect(result.profileId).not.toBeNull();
    });

    it("binds a second identifier to the profile the first already made", async () => {
      const repo = createKyselyProfileRepository(db);
      const anon = ident("anonymous_id", "login-anon");
      const cust = ident("customer_id", "login-cust");

      const browsing = await repo.resolveProfile(resolveInput([anon]));
      const login = await repo.resolveProfile(resolveInput([anon, cust]));

      // The login transition, against real SQL this time.
      expect(login.profileId).toBe(browsing.profileId);
      expect(login.canonicalCustomerId).toBe(cust.value);

      const bound = await db
        .selectFrom("profile_identifiers")
        .select(["kind", "profile_id"])
        .where("value", "in", [anon.value, cust.value])
        .execute();
      expect(bound).toHaveLength(2);
      expect(new Set(bound.map((r) => r.profile_id)).size).toBe(1);
    });

    it("merges two profiles that turn out to be one person, and repoints eagerly", async () => {
      const repo = createKyselyProfileRepository(db);
      const anon = ident("anonymous_id", "merge-anon");
      const cust = ident("customer_id", "merge-cust");

      const a = await repo.resolveProfile(resolveInput([anon]));
      const b = await repo.resolveProfile(resolveInput([cust]));
      expect(a.profileId).not.toBe(b.profileId);

      const merged = await repo.resolveProfile(resolveInput([anon, cust]));
      expect(merged.kind).toBe("merged");
      // Older wins. `a` was created first, so it survives.
      expect(merged.profileId).toBe(a.profileId);

      // Eager repointing is what lets the read path be one lookup:
      // BOTH identifiers now resolve to the winner, with no need to
      // traverse `merged_into`.
      const rows = await db
        .selectFrom("profile_identifiers")
        .select(["value", "profile_id"])
        .where("value", "in", [anon.value, cust.value])
        .execute();
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row.profile_id).toBe(a.profileId);

      // The loser is tombstoned, not deleted: the merge is auditable.
      const loser = await db
        .selectFrom("profiles")
        .select(["merged_into"])
        .where("profile_id", "=", b.profileId as string)
        .executeTakeFirst();
      expect(loser?.merged_into).toBe(a.profileId);
    });
  });

  describe("trait patches under concurrency", () => {
    it("does not lose an update when two identifies race the same profile", async () => {
      // The R1B review finding, verified end to end. `patchProfile` is a
      // read-modify-write; `raw.events` is keyed on the identity fallback
      // chain, so one person's events genuinely straddle two partitions
      // until login and two workers can reach this row at once. Without
      // FOR UPDATE one whole patch vanishes and both events claim the
      // same traits_version.
      const repo = createKyselyProfileRepository(db);
      const cust = ident("customer_id", "traits-race");
      await repo.resolveProfile(resolveInput([cust]));

      const [left, right] = await Promise.all([
        repo.resolveProfile(resolveInput([cust], { traits: { from_left: true } })),
        repo.resolveProfile(resolveInput([cust], { traits: { from_right: true } })),
      ]);

      // Serialised by the lock, so the versions are distinct and
      // consecutive rather than both landing on the same number.
      const versions = [left.traitsVersion, right.traitsVersion].sort(
        (x, y) => Number(x) - Number(y),
      );
      expect(versions[0]).not.toBe(versions[1]);

      // And neither patch was lost: merge-patch semantics mean the row
      // ends up carrying BOTH keys.
      const row = await db
        .selectFrom("profiles")
        .select(["traits", "traits_version"])
        .where("profile_id", "=", left.profileId as string)
        .executeTakeFirst();
      const traits = row?.traits as Record<string, unknown>;
      expect(traits["from_left"]).toBe(true);
      expect(traits["from_right"]).toBe(true);
      expect(Number(row?.traits_version)).toBe(Number(versions[1]));
    });

    it("is idempotent under redelivery: the same event twice changes nothing", async () => {
      const repo = createKyselyProfileRepository(db);
      const cust = ident("customer_id", "redeliver");
      const input = resolveInput([cust], { traits: { tier: "gold" } });

      const first = await repo.resolveProfile(input);
      const second = await repo.resolveProfile(input);

      expect(second.profileId).toBe(first.profileId);
      // The identifier binds once; the second pass reports nothing newly
      // bound, which is what stops a linked-fact per delivery forever.
      expect(second.bound.every((b) => !b.newlyBound)).toBe(true);

      const rows = await db
        .selectFrom("profile_identifiers")
        .select("profile_id")
        .where("value", "=", cust.value)
        .execute();
      expect(rows).toHaveLength(1);
    });

    it("writes the pair evidence once per event, not once per delivery", async () => {
      // The other R1B review finding: `identity_links` has no unique
      // constraint on the pair, so a random link id made the ON CONFLICT
      // unreachable and the ledger grew a row per delivery.
      const repo = createKyselyProfileRepository(db);
      const anon = ident("anonymous_id", "ledger-anon");
      const cust = ident("customer_id", "ledger-cust");
      const input = resolveInput([anon, cust]);

      await repo.resolveProfile(input);
      await repo.resolveProfile(input);
      await repo.resolveProfile(resolveInput([anon, cust]));

      const links = await db
        .selectFrom("identity_links")
        .select(["link_id"])
        .where("left_identifier", "like", `%${runTag}-ledger%`)
        .execute();
      expect(links).toHaveLength(1);
    });
  });

  describe("the enrichment stage's read", () => {
    it("sees a profile the resolver committed, with no read-your-writes machinery", async () => {
      // The commit-before-publish invariant from the READER's side. The
      // resolver's transaction has committed by the time it publishes,
      // so a separate connection — which is what the enrichment stage
      // is, a different process entirely — observes the row immediately.
      const repo = createKyselyProfileRepository(db);
      const reader = createKyselyProfileReader(db);
      const cust = ident("customer_id", "read-after-commit");

      const resolved = await repo.resolveProfile(
        resolveInput([cust], { traits: { tier: "gold", ltv_band: "high" } }),
      );

      const snapshot = await reader.readProfile(resolved.profileId as string);
      expect(snapshot).not.toBeNull();
      expect(snapshot?.traits).toEqual({ tier: "gold", ltv_band: "high" });
      expect(snapshot?.traitsVersion).toBe(resolved.traitsVersion);
    });

    it("returns null for a profile id no row bears", async () => {
      const reader = createKyselyProfileReader(db);
      // A well-formed uuid that was never issued — the shape of a replay
      // from an archive older than the store.
      expect(await reader.readProfile("019ffe00-0000-7000-8000-0000deadbeef")).toBeNull();
    });

    it("reads a bigint traits_version back as a usable number", async () => {
      // `traits_version` is `bigint`, which the driver hands back as a
      // string. A reader that forwarded it raw would put a string into
      // the envelope's numeric slot and fail schema validation
      // downstream — silently, since processors do not re-run Zod on the
      // hot path.
      const repo = createKyselyProfileRepository(db);
      const reader = createKyselyProfileReader(db);
      const cust = ident("customer_id", "bigint-version");

      const resolved = await repo.resolveProfile(resolveInput([cust], { traits: { a: 1 } }));
      const snapshot = await reader.readProfile(resolved.profileId as string);

      expect(typeof snapshot?.traitsVersion).toBe("number");
      expect(snapshot?.traitsVersion).toBe(1);
    });
  });
});
