/**
 * The decision procedure, against its storage port.
 *
 * Everything here runs with no broker and no database — the point of the
 * port. What is being pinned is the behaviour a replay depends on: the
 * same events produce the same graph, the same ids, and the same facts,
 * because unmerge is replay-rebuild and this function is what a rebuild
 * re-runs.
 */

import type { CollectedIdentifier, IdentityPolicy } from "@polaris/identity-rules";
import type { ResolveInput } from "@polaris/profiles";
import { describe, expect, it } from "vitest";

import { resolveIdentity } from "../src/index.js";
import { FakeGraphStore } from "./fake-store.js";

const NOW = new Date("2026-08-20T12:00:00.000Z");
const SCOPE = { projectId: "storefront", environment: "production" };

const POLICY: IdentityPolicy = {
  denylist: {},
  maxIdentifiersPerKind: 100,
  maxMergesPerWindow: 50,
  mergeWindowSeconds: 3600,
  maxTraitsBytes: 32768,
};

function input(overrides: Partial<ResolveInput> = {}): ResolveInput {
  return {
    projectId: SCOPE.projectId,
    environment: SCOPE.environment,
    identifiers: [],
    traits: null,
    sourceEventId: "evt-1",
    sourceEventName: "page.viewed",
    runId: "run-1",
    policy: POLICY,
    now: NOW,
    ...overrides,
  };
}

const ANON: CollectedIdentifier = { kind: "anonymous_id", value: "anon-1" };
const CUST: CollectedIdentifier = { kind: "customer_id", value: "cust-1" };

describe("resolveIdentity", () => {
  it("resolves an event with no identifiers without touching the store", () => {
    // The store here is a Proxy that throws on any access, which is the
    // assertion: the spine's unidentifiable events must not cost a round
    // trip, let alone a transaction.
    const forbidden = new Proxy({} as never, {
      get() {
        throw new Error("the store was reached");
      },
    });
    return expect(resolveIdentity(forbidden, input())).resolves.toMatchObject({
      kind: "unidentified",
      profileId: null,
    });
  });

  it("locks every identifier BEFORE looking anything up", async () => {
    // `SELECT ... FOR UPDATE` locks the rows it finds, which is nothing on
    // a first sighting — two workers then both create a profile and one
    // walks away with an orphan. The lock is taken on the VALUE, so it
    // exists whether or not the row does.
    const store = new FakeGraphStore();
    await resolveIdentity(store, input({ identifiers: [ANON, CUST] }));

    const lockIndexes = store.calls
      .map((call, index) => (call.startsWith("lock:") ? index : -1))
      .filter((index) => index >= 0);
    const lookup = store.calls.indexOf("findBindings");
    expect(lockIndexes).toHaveLength(2);
    expect(Math.max(...lockIndexes)).toBeLessThan(lookup);
  });

  it("locks in the order the caller sorted the identifiers into", async () => {
    // Consistent lock ordering across workers is what turns a deadlock
    // into a queue.
    const store = new FakeGraphStore();
    await resolveIdentity(store, input({ identifiers: [ANON, CUST] }));
    expect(store.calls.filter((call) => call.startsWith("lock:"))).toEqual([
      "lock:polaris:identity:storefront:production:anonymous_id:anon-1",
      "lock:polaris:identity:storefront:production:customer_id:cust-1",
    ]);
  });

  it("creates a profile when nothing resolves", async () => {
    const store = new FakeGraphStore();
    const result = await resolveIdentity(store, input({ identifiers: [ANON] }));
    expect(result.kind).toBe("created");
    expect(result.bound).toEqual([{ ...ANON, newlyBound: true }]);
    expect(store.bindings.get("storefront|production|anonymous_id|anon-1")).toBe(result.profileId);
  });

  it("binds a new identifier to the profile the old one already names", async () => {
    // The login transition the whole redesign exists to survive.
    const store = new FakeGraphStore();
    store.seedProfile({ profileId: "p-1", firstSeenAt: new Date("2026-08-01T00:00:00.000Z") });
    store.seedBinding(SCOPE, "anonymous_id", "anon-1", "p-1");

    const result = await resolveIdentity(store, input({ identifiers: [ANON, CUST] }));
    expect(result.kind).toBe("bound");
    expect(result.profileId).toBe("p-1");
    expect(result.canonicalCustomerId).toBe("cust-1");
    expect(store.bindings.get("storefront|production|customer_id|cust-1")).toBe("p-1");
  });

  it("re-seeing a bound identifier is not news", async () => {
    // Emitting a fact for it would put one identity.linked on every event
    // forever.
    const store = new FakeGraphStore();
    store.seedProfile({ profileId: "p-1", firstSeenAt: new Date("2026-08-01T00:00:00.000Z") });
    store.seedBinding(SCOPE, "anonymous_id", "anon-1", "p-1");

    const result = await resolveIdentity(store, input({ identifiers: [ANON] }));
    expect(result.bound).toEqual([{ ...ANON, newlyBound: false }]);
    expect(store.calls).toContain("touch:anonymous_id:anon-1");
  });

  it("merges two profiles onto the older one and repoints eagerly", async () => {
    const store = new FakeGraphStore();
    store.seedProfile({ profileId: "p-old", firstSeenAt: new Date("2026-01-01T00:00:00.000Z") });
    store.seedProfile({ profileId: "p-new", firstSeenAt: new Date("2026-08-01T00:00:00.000Z") });
    store.seedBinding(SCOPE, "anonymous_id", "anon-1", "p-new");
    store.seedBinding(SCOPE, "customer_id", "cust-1", "p-old");

    const result = await resolveIdentity(store, input({ identifiers: [ANON, CUST] }));
    expect(result.kind).toBe("merged");
    expect(result.merge).toMatchObject({
      winnerProfileId: "p-old",
      loserProfileId: "p-new",
      identifiersMoved: 1,
    });
    // Eager: after the merge every binding names the survivor, so a read
    // never has to traverse `merged_into`.
    expect([...store.bindings.values()]).toEqual(["p-old", "p-old"]);
    expect(store.merges).toHaveLength(1);
  });

  it("refuses a merge when the breaker has tripped, and keeps the event flowing", async () => {
    // A merge storm is a data-quality incident. Halting the project's
    // pipeline over it would make it an outage.
    const store = new FakeGraphStore();
    store.seedProfile({ profileId: "p-old", firstSeenAt: new Date("2026-01-01T00:00:00.000Z") });
    store.seedProfile({ profileId: "p-new", firstSeenAt: new Date("2026-08-01T00:00:00.000Z") });
    store.seedBinding(SCOPE, "anonymous_id", "anon-1", "p-new");
    store.seedBinding(SCOPE, "customer_id", "cust-1", "p-old");
    for (let i = 0; i < 2; i += 1) {
      await store.recordMerge({
        mergeId: `seed-${i}`,
        scope: SCOPE,
        winnerProfileId: "p-old",
        loserProfileId: `x-${i}`,
        sourceEventId: "seed",
        evidence: {},
        mergedAt: NOW,
      });
    }

    const result = await resolveIdentity(
      store,
      input({ identifiers: [ANON, CUST], policy: { ...POLICY, maxMergesPerWindow: 2 } }),
    );
    expect(result.kind).toBe("bound");
    expect(result.profileId).toBe("p-old");
    expect(result.mergeSuspended).toEqual({ profileId: "p-old", mergeCount: 2 });
    // Nothing bound: moving the event's identifiers to the winner would BE
    // the merge.
    expect(result.bound).toEqual([]);
    expect(store.bindings.get("storefront|production|anonymous_id|anon-1")).toBe("p-new");
  });

  it("refuses a binding past the per-kind cap, and says why", async () => {
    const store = new FakeGraphStore();
    store.seedProfile({ profileId: "p-1", firstSeenAt: new Date("2026-08-01T00:00:00.000Z") });
    store.seedBinding(SCOPE, "anonymous_id", "anon-1", "p-1");
    store.seedBinding(SCOPE, "customer_id", "cust-old", "p-1");

    const result = await resolveIdentity(
      store,
      input({ identifiers: [ANON, CUST], policy: { ...POLICY, maxIdentifiersPerKind: 1 } }),
    );
    expect(result.rejected).toEqual([
      { ...CUST, reason: "identifier_cap", existingBindingCount: 1 },
    ]);
    // And the refused id must not become canonical: its binding resolves
    // elsewhere, and destinations key on this column.
    expect(result.canonicalCustomerId).toBeNull();
  });

  it("writes one evidence row per event, not one per identifier", async () => {
    // `identity_links` has no unique constraint on the pair, so a
    // per-identifier write would grow the ledger twice per login and again
    // on every redelivery.
    const store = new FakeGraphStore();
    await resolveIdentity(store, input({ identifiers: [ANON, CUST] }));
    expect(store.links).toHaveLength(1);
    expect(store.links[0]).toMatchObject({
      leftIdentifier: "anonymous_id:anon-1",
      rightIdentifier: "customer_id:cust-1",
      evidenceType: "explicit_overlap",
    });
  });

  it("does not re-evidence a pair that changed nothing", async () => {
    const store = new FakeGraphStore();
    await resolveIdentity(store, input({ identifiers: [ANON, CUST] }));
    await resolveIdentity(store, input({ identifiers: [ANON, CUST], sourceEventId: "evt-2" }));
    expect(store.links).toHaveLength(1);
  });

  it("is idempotent under redelivery", async () => {
    // Every step is an upsert or a no-op, so a replayed event converges on
    // the graph it already produced rather than duplicating it.
    const store = new FakeGraphStore();
    const first = await resolveIdentity(store, input({ identifiers: [ANON, CUST] }));
    const bindingsAfterFirst = new Map(store.bindings);

    const second = await resolveIdentity(store, input({ identifiers: [ANON, CUST] }));
    expect(second.profileId).toBe(first.profileId);
    expect(second.bound.every((b) => !b.newlyBound)).toBe(true);
    expect(store.bindings).toEqual(bindingsAfterFirst);
    expect(store.merges).toHaveLength(0);
  });

  it("merge-patches traits per key and bumps the version", async () => {
    const store = new FakeGraphStore();
    await resolveIdentity(store, input({ identifiers: [ANON], traits: { plan: "free" } }));
    const patched = await resolveIdentity(
      store,
      input({ identifiers: [ANON], traits: { tier: "gold" }, sourceEventId: "evt-2" }),
    );
    expect(patched.traitsPatched).toBe(true);
    expect(patched.traitsVersion).toBe(2);
    expect(store.profiles.get(patched.profileId as string)?.traits).toEqual({
      plan: "free",
      tier: "gold",
    });
  });
});
