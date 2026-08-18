/**
 * The audiences runner (C195TM1C).
 *
 * Drives `runAudiences` against in-memory doubles. The assertions that
 * matter are about ORDER and SILENCE: the membership write must land
 * before the event that announces it, and a second run over an unchanged
 * population must touch nothing.
 */

import { type AudienceDefinition, audienceDefinitionSchema } from "@polaris/audience-catalog";
import { describe, expect, it } from "vitest";

import {
  type AudienceEmitter,
  type AudienceMembershipStore,
  type AudienceProfileStore,
  type AudienceQueryRunner,
  runAudiences,
  type StoredMembership,
} from "../src/index.js";

const RECENT: AudienceDefinition = audienceDefinitionSchema.parse({
  key: "recent_purchasers",
  version: 1,
  description: "test",
  source: "traits",
  predicate: { trait: "orders_30d", op: "gte", value: 1 },
});

interface Row extends StoredMembership {
  audienceVersion: number;
}

/**
 * Membership store double. Records the call order alongside the emitter
 * so the write-then-emit sequence is assertable.
 */
function membershipStore(initial: readonly Row[], log: string[]) {
  const rows = new Map<string, Row>(initial.map((r) => [r.profileId, { ...r }]));
  const store: AudienceMembershipStore = {
    listMemberships: async () => [...rows.values()],
    enter: async ({ profileId, audienceVersion }) => {
      log.push(`write:enter:${profileId}`);
      const enteredAt = new Date("2026-08-16T00:00:00.000Z");
      rows.set(profileId, { profileId, enteredAt, exitedAt: null, audienceVersion });
      return { enteredAt };
    },
    exit: async ({ profileId }) => {
      log.push(`write:exit:${profileId}`);
      const existing = rows.get(profileId);
      if (existing !== undefined) {
        rows.set(profileId, { ...existing, exitedAt: new Date("2026-08-16T00:00:00.000Z") });
      }
    },
    restamp: async ({ profileIds, audienceVersion }) => {
      log.push(`write:restamp:${profileIds.join(",")}`);
      for (const id of profileIds) {
        const existing = rows.get(id);
        if (existing !== undefined) rows.set(id, { ...existing, audienceVersion });
      }
    },
  };
  return { store, rows };
}

function emitter(log: string[]) {
  const entered: Array<{ profileId: string; reEntry: boolean; audienceVersion: number }> = [];
  const exited: Array<{ profileId: string; enteredAt: Date; audienceVersion: number }> = [];
  const impl: AudienceEmitter = {
    entered: async (input) => {
      log.push(`emit:entered:${input.profileId}`);
      entered.push({
        profileId: input.profileId,
        reEntry: input.reEntry,
        audienceVersion: input.audienceVersion,
      });
    },
    exited: async (input) => {
      log.push(`emit:exited:${input.profileId}`);
      exited.push({
        profileId: input.profileId,
        enteredAt: input.enteredAt,
        audienceVersion: input.audienceVersion,
      });
    },
  };
  return { impl, entered, exited };
}

function profileStore(
  profiles: ReadonlyArray<{ profileId: string; traits: Record<string, unknown> }>,
): AudienceProfileStore & { keysAsked: string[][] } {
  const keysAsked: string[][] = [];
  return {
    keysAsked,
    profilesWithTraits: async ({ keys }) => {
      keysAsked.push([...keys]);
      return profiles;
    },
  };
}

describe("runAudiences — first run", () => {
  it("enters everyone who qualifies and nobody who does not", async () => {
    const log: string[] = [];
    const { store } = membershipStore([], log);
    const emit = emitter(log);
    const result = await runAudiences({
      projectId: "storefront",
      environment: "production",
      audiences: [RECENT],
      profiles: profileStore([
        { profileId: "p1", traits: { orders_30d: 3 } },
        { profileId: "p2", traits: { orders_30d: 0 } },
        { profileId: "p3", traits: {} },
      ]),
      memberships: store,
      emitter: emit.impl,
      runId: "run-1",
    });

    expect(emit.entered.map((e) => e.profileId)).toEqual(["p1"]);
    expect(emit.exited).toEqual([]);
    expect(result.perAudience[0]?.members).toBe(1);
    expect(result.transitions).toBe(1);
  });

  it("asks the profile store only for the traits the predicate reads", async () => {
    const log: string[] = [];
    const { store } = membershipStore([], log);
    const profiles = profileStore([]);
    await runAudiences({
      projectId: "storefront",
      environment: "production",
      audiences: [RECENT],
      profiles,
      memberships: store,
      emitter: emitter(log).impl,
      runId: "run-1",
    });
    expect(profiles.keysAsked[0]).toEqual(["orders_30d"]);
  });

  it("writes the membership BEFORE emitting the event", async () => {
    // Order is the idempotence boundary. Emitting first would risk
    // announcing a membership that was never recorded, and the next run
    // would announce it again — a duplicate that has already reached a
    // vendor. A lost transition is recoverable; a phantom one is not.
    const log: string[] = [];
    const { store } = membershipStore([], log);
    await runAudiences({
      projectId: "storefront",
      environment: "production",
      audiences: [RECENT],
      profiles: profileStore([{ profileId: "p1", traits: { orders_30d: 3 } }]),
      memberships: store,
      emitter: emitter(log).impl,
      runId: "run-1",
    });
    expect(log).toEqual(["write:enter:p1", "emit:entered:p1"]);
  });
});

describe("runAudiences — idempotence", () => {
  it("emits nothing on a re-run over an unchanged population", async () => {
    const log: string[] = [];
    const { store } = membershipStore([], log);
    const profiles = profileStore([{ profileId: "p1", traits: { orders_30d: 3 } }]);
    const base = {
      projectId: "storefront",
      environment: "production",
      audiences: [RECENT],
      profiles,
      memberships: store,
    };

    await runAudiences({ ...base, emitter: emitter(log).impl, runId: "run-1" });
    log.length = 0;

    const second = emitter(log);
    const result = await runAudiences({ ...base, emitter: second.impl, runId: "run-2" });

    expect(second.entered).toEqual([]);
    expect(second.exited).toEqual([]);
    expect(result.transitions).toBe(0);
    // No writes either — not just no events.
    expect(log).toEqual([]);
  });
});

describe("runAudiences — exits", () => {
  it("exits a member who stopped qualifying and emits with the membership start", async () => {
    const log: string[] = [];
    const enteredAt = new Date("2026-07-01T00:00:00.000Z");
    const { store } = membershipStore(
      [{ profileId: "p1", enteredAt, exitedAt: null, audienceVersion: 1 }],
      log,
    );
    const emit = emitter(log);
    await runAudiences({
      projectId: "storefront",
      environment: "production",
      audiences: [RECENT],
      profiles: profileStore([{ profileId: "p1", traits: { orders_30d: 0 } }]),
      memberships: store,
      emitter: emit.impl,
      runId: "run-1",
    });

    expect(emit.exited).toEqual([{ profileId: "p1", enteredAt, audienceVersion: 1 }]);
    expect(log).toEqual(["write:exit:p1", "emit:exited:p1"]);
  });

  it("exits everyone when the trait the predicate reads goes absent", async () => {
    // Per catalog/traits, absent is "not computed", not zero — so a trait
    // that fails to compute empties every audience built on it. Intended:
    // an audience whose input is unknown has no defensible membership.
    const log: string[] = [];
    const { store } = membershipStore(
      [
        { profileId: "p1", enteredAt: new Date(), exitedAt: null, audienceVersion: 1 },
        { profileId: "p2", enteredAt: new Date(), exitedAt: null, audienceVersion: 1 },
      ],
      log,
    );
    const emit = emitter(log);
    await runAudiences({
      projectId: "storefront",
      environment: "production",
      audiences: [RECENT],
      profiles: profileStore([
        { profileId: "p1", traits: {} },
        { profileId: "p2", traits: {} },
      ]),
      memberships: store,
      emitter: emit.impl,
      runId: "run-1",
    });
    expect(emit.exited.map((e) => e.profileId).sort()).toEqual(["p1", "p2"]);
  });

  it("marks a returning member as a re-entry", async () => {
    const log: string[] = [];
    const { store } = membershipStore(
      [
        {
          profileId: "p1",
          enteredAt: new Date("2026-06-01T00:00:00.000Z"),
          exitedAt: new Date("2026-07-01T00:00:00.000Z"),
          audienceVersion: 1,
        },
      ],
      log,
    );
    const emit = emitter(log);
    await runAudiences({
      projectId: "storefront",
      environment: "production",
      audiences: [RECENT],
      profiles: profileStore([{ profileId: "p1", traits: { orders_30d: 2 } }]),
      memberships: store,
      emitter: emit.impl,
      runId: "run-1",
    });
    expect(emit.entered).toEqual([{ profileId: "p1", reEntry: true, audienceVersion: 1 }]);
  });
});

describe("runAudiences — version bump", () => {
  it("restamps a continuing member without emitting", async () => {
    const log: string[] = [];
    const { store, rows } = membershipStore(
      [{ profileId: "p1", enteredAt: new Date(), exitedAt: null, audienceVersion: 1 }],
      log,
    );
    const emit = emitter(log);
    const v2 = audienceDefinitionSchema.parse({ ...RECENT, version: 2 });

    await runAudiences({
      projectId: "storefront",
      environment: "production",
      audiences: [v2],
      profiles: profileStore([{ profileId: "p1", traits: { orders_30d: 3 } }]),
      memberships: store,
      emitter: emit.impl,
      runId: "run-1",
    });

    expect(emit.entered).toEqual([]);
    expect(emit.exited).toEqual([]);
    expect(log).toEqual(["write:restamp:p1"]);
    expect(rows.get("p1")?.audienceVersion).toBe(2);
  });
});

describe("runAudiences — projection source", () => {
  const PROJECTION: AudienceDefinition = audienceDefinitionSchema.parse({
    key: "from_projection",
    version: 1,
    description: "test",
    source: "projection",
    sql: "SELECT profile_id FROM polaris.event_daily_counts WHERE project_id = {project:String}",
  });

  it("takes its population from the query and never touches the profile store", async () => {
    const log: string[] = [];
    const { store } = membershipStore([], log);
    const emit = emitter(log);
    const profiles = profileStore([{ profileId: "should-not-be-read", traits: {} }]);
    const query: AudienceQueryRunner = {
      run: async () => [{ profile_id: "p9" }],
    };

    await runAudiences({
      projectId: "storefront",
      environment: "production",
      audiences: [PROJECTION],
      profiles,
      memberships: store,
      emitter: emit.impl,
      query,
      runId: "run-1",
    });

    expect(emit.entered.map((e) => e.profileId)).toEqual(["p9"]);
    expect(profiles.keysAsked).toEqual([]);
  });

  it("refuses to run a projection audience with no query runner", async () => {
    const log: string[] = [];
    const { store } = membershipStore([], log);
    await expect(
      runAudiences({
        projectId: "storefront",
        environment: "production",
        audiences: [PROJECTION],
        profiles: profileStore([]),
        memberships: store,
        emitter: emitter(log).impl,
        runId: "run-1",
      }),
    ).rejects.toThrow(/projection-sourced/);
  });
});
