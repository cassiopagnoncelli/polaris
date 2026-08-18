/**
 * Behavioural tests for the identity stage.
 *
 * These assert the PROPERTIES the redesign depends on, not the shape of
 * the code: that a login links an anonymous history to a person, that a
 * replay converges instead of duplicating, that the safeguards refuse
 * loudly, and that an unidentifiable event still reaches the spine.
 */

import { sharedOnlyIsolationLookup } from "@polaris/shared-transport";
import { describe, expect, it } from "vitest";

import { handleEvent } from "../src/runtime.js";
import type { IdentityPolicy } from "../src/transform.js";
import { InMemoryProfileRepository, RecordingProducer, silentLogger } from "./fakes.js";

const IDENTIFIED = "identified.events";
const IDENTITY = "identity.events";
const PROFILE = "profile.events";

const BASE_POLICY: IdentityPolicy = {
  denylist: {},
  maxIdentifiersPerKind: 100,
  maxMergesPerWindow: 50,
  mergeWindowSeconds: 3600,
  maxTraitsBytes: 32768,
};

function makeDeps(policy: Partial<IdentityPolicy> = {}, nowFn?: () => Date) {
  const repository = new InMemoryProfileRepository();
  const producer = new RecordingProducer();
  const now = new Date("2026-08-14T00:00:00.000Z");
  return {
    repository,
    producer,
    isolation: sharedOnlyIsolationLookup,
    deps: {
      repository,
      producer,
      isolation: sharedOnlyIsolationLookup,
      logger: silentLogger,
      policyFor: () => ({ ...BASE_POLICY, ...policy }),
      runId: () => "run_1",
      now: nowFn ?? (() => now),
    },
  };
}

let seq = 0;
function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  return {
    event_id: `019ffe00-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    event: "page.viewed",
    schema_version: 1,
    project_id: "storefront",
    environment: "development",
    occurred_at: "2026-08-14T00:00:00.000Z",
    ingested_at: "2026-08-14T00:00:01.000Z",
    source: { type: "browser", id: "storefront-web" },
    identity: { anonymous_id: null, session_id: null, customer_id: null, device_id: null },
    context: { ip: null, user_agent: null, locale: null, page: null, campaign: null },
    properties: {},
    ...overrides,
  };
}

function identity(over: Record<string, string | null>): Record<string, unknown> {
  return { anonymous_id: null, session_id: null, customer_id: null, device_id: null, ...over };
}

describe("identity stage: resolution", () => {
  it("creates a profile for an anonymous-only event and stamps it on the spine", async () => {
    const { producer, deps } = makeDeps();
    const result = await handleEvent(
      deps,
      event({ identity: identity({ anonymous_id: "anon_1" }) }),
    );

    expect(result.kind).toBe("created");
    const spine = producer.eventsOn(IDENTIFIED)[0];
    expect((spine?.["profile"] as Record<string, unknown>)["profile_id"]).toBe(result.profileId);
    expect((spine?.["profile"] as Record<string, unknown>)["canonical_customer_id"]).toBeNull();
  });

  it("links an anonymous history to the person on login — the transition the redesign exists for", async () => {
    const { repository, producer, deps } = makeDeps();
    // Anonymous browsing, then a login carrying both identifiers.
    const first = await handleEvent(
      deps,
      event({ identity: identity({ anonymous_id: "anon_1" }) }),
    );
    const second = await handleEvent(
      deps,
      event({ identity: identity({ anonymous_id: "anon_1", customer_id: "cus_1" }) }),
    );

    // Same person: the login did NOT create a second profile.
    expect(second.profileId).toBe(first.profileId);
    expect(repository.profileCount).toBe(1);
    expect(second.canonicalCustomerId).toBe("cus_1");
    // And the customer id now resolves to that same profile forever.
    expect(repository.resolveIdentifier("storefront", "development", "customer_id", "cus_1")).toBe(
      first.profileId,
    );
    expect(producer.eventsOn(IDENTIFIED)).toHaveLength(2);
  });

  it("merges two profiles when an event proves they are one person", async () => {
    const { repository, producer, deps } = makeDeps();
    // Two independent profiles form first...
    const a = await handleEvent(deps, event({ identity: identity({ anonymous_id: "anon_1" }) }));
    const b = await handleEvent(deps, event({ identity: identity({ customer_id: "cus_1" }) }));
    expect(a.profileId).not.toBe(b.profileId);
    expect(repository.profileCount).toBe(2);

    // ...then one event carries both.
    const merged = await handleEvent(
      deps,
      event({ identity: identity({ anonymous_id: "anon_1", customer_id: "cus_1" }) }),
    );

    expect(merged.kind).toBe("merged");
    expect(repository.profileCount).toBe(1);
    expect(merged.merge?.winnerProfileId).toBe(a.profileId); // older wins
    expect(merged.merge?.loserProfileId).toBe(b.profileId);
    expect(producer.names(IDENTITY)).toContain("identity.merged");
  });

  it("picks the same merge winner on a replay (older first_seen_at wins)", async () => {
    const run = async () => {
      // A real clock advances between events; the winner rule is keyed on
      // it, so the test must not flatten every first_seen_at into a tie.
      let tick = 0;
      const clock = () => new Date(Date.UTC(2026, 7, 14, 0, 0, tick++));
      const { deps } = makeDeps({}, clock);
      const anonProfile = await handleEvent(
        deps,
        event({ identity: identity({ anonymous_id: "anon_x" }) }),
      );
      await handleEvent(deps, event({ identity: identity({ customer_id: "cus_x" }) }));
      const merged = await handleEvent(
        deps,
        event({ identity: identity({ anonymous_id: "anon_x", customer_id: "cus_x" }) }),
      );
      return { anonProfileId: anonProfile.profileId, merge: merged.merge };
    };
    const first = await run();
    const second = await run();
    // Ids differ across runs (uuidv7 in production), so equality of ids
    // is not the property — the RULE is: the OLDER profile (the
    // anonymous history) wins in EVERY run, so a rebuild converges on
    // the same shape instead of shuffling survivors.
    expect(first.merge?.winnerProfileId).toBe(first.anonProfileId);
    expect(second.merge?.winnerProfileId).toBe(second.anonProfileId);
    expect(first.merge?.identifiersMoved).toBe(1);
    expect(second.merge?.identifiersMoved).toBe(1);
  });

  it("forwards an event with no strong identifier instead of dropping it", async () => {
    const { producer, deps } = makeDeps();
    const result = await handleEvent(deps, event({ identity: identity({ session_id: "sess_1" }) }));

    expect(result.kind).toBe("unidentified");
    expect(result.profileId).toBeNull();
    const spine = producer.eventsOn(IDENTIFIED)[0];
    expect(spine).toBeDefined();
    expect(spine?.["profile"]).toBeNull();
  });

  it("is idempotent under redelivery: the same event twice changes nothing", async () => {
    const { repository, deps } = makeDeps();
    const raw = event({ identity: identity({ anonymous_id: "anon_1", customer_id: "cus_1" }) });
    const first = await handleEvent(deps, raw);
    const second = await handleEvent(deps, raw);

    expect(second.profileId).toBe(first.profileId);
    expect(repository.profileCount).toBe(1);
    // The second pass binds nothing new, so it emits no linked facts.
    expect(second.bound.every((b) => !b.newlyBound)).toBe(true);
  });
});

describe("identity stage: spine event", () => {
  it("preserves event_id and ingested_at, because the spine event IS the source fact", async () => {
    const { producer, deps } = makeDeps();
    const raw = event({ identity: identity({ anonymous_id: "anon_1" }) });
    await handleEvent(deps, raw);

    const spine = producer.eventsOn(IDENTIFIED)[0];
    expect(spine?.["event_id"]).toBe(raw["event_id"]);
    expect(spine?.["event"]).toBe(raw["event"]);
    expect(spine?.["schema_version"]).toBe(raw["schema_version"]);
    expect(spine?.["occurred_at"]).toBe(raw["occurred_at"]);
    // Restamping ingested_at would corrupt lag metrics AND change how
    // analytics_raw._version dedupes against the legacy feed during the
    // M3 dual-run.
    expect(spine?.["ingested_at"]).toBe(raw["ingested_at"]);
  });

  it("partitions by profile, so one person keeps one partition across login", async () => {
    const { producer, deps } = makeDeps();
    await handleEvent(deps, event({ identity: identity({ anonymous_id: "anon_1" }) }));
    await handleEvent(
      deps,
      event({ identity: identity({ anonymous_id: "anon_1", customer_id: "cus_1" }) }),
    );

    const keys = producer.published
      .filter((p) => p.family === IDENTIFIED)
      .map((p) => p.partitionKey);
    expect(keys[0]).toBe(keys[1]);
  });
});

describe("identity stage: merge safeguards", () => {
  it("refuses a denylisted identifier and says so, without touching the profile", async () => {
    const { repository, producer, deps } = makeDeps({
      denylist: { customer_id: new Set(["guest"]) },
    });
    const result = await handleEvent(
      deps,
      event({ identity: identity({ anonymous_id: "anon_1", customer_id: "guest" }) }),
    );

    // The event still resolves on its usable identifier...
    expect(result.profileId).not.toBeNull();
    expect(result.canonicalCustomerId).toBeNull();
    // ...and "guest" never becomes an identifier that could chain-merge
    // every guest checkout into one mega-profile.
    expect(
      repository.resolveIdentifier("storefront", "development", "customer_id", "guest"),
    ).toBeUndefined();
    expect(producer.names(IDENTITY)).toContain("identity.link_rejected");
  });

  it("refuses bindings past the per-kind cap rather than growing a hot profile", async () => {
    const { producer, deps } = makeDeps({ maxIdentifiersPerKind: 1 });
    await handleEvent(deps, event({ identity: identity({ anonymous_id: "anon_1" }) }));
    // A second anonymous id for the same person: over the cap of 1.
    await handleEvent(
      deps,
      event({ identity: identity({ anonymous_id: "anon_2", customer_id: "cus_1" }) }),
    );
    const third = await handleEvent(
      deps,
      event({ identity: identity({ anonymous_id: "anon_3", customer_id: "cus_1" }) }),
    );

    expect(third.rejected.some((r) => r.reason === "identifier_cap")).toBe(true);
    expect(producer.names(IDENTITY)).toContain("identity.link_rejected");
  });

  it("trips the merge-rate breaker and stops merging, emitting merge_suspended", async () => {
    const { repository, producer, deps } = makeDeps({ maxMergesPerWindow: 1 });
    // First merge is allowed.
    await handleEvent(deps, event({ identity: identity({ anonymous_id: "a1" }) }));
    await handleEvent(deps, event({ identity: identity({ customer_id: "c1" }) }));
    await handleEvent(
      deps,
      event({ identity: identity({ anonymous_id: "a1", customer_id: "c1" }) }),
    );

    // Second merge onto the same winner trips the breaker.
    const other = await handleEvent(deps, event({ identity: identity({ anonymous_id: "a2" }) }));
    const suspended = await handleEvent(
      deps,
      event({ identity: identity({ anonymous_id: "a2", customer_id: "c1" }) }),
    );

    expect(suspended.mergeSuspended).not.toBeNull();
    expect(suspended.merge).toBeNull();
    expect(producer.names(IDENTITY)).toContain("identity.merge_suspended");
    // Suspension binds NOTHING: repointing a2 at the winner would be the
    // merge the breaker just refused, so a2 keeps resolving to its own
    // profile until an operator (or a later window) lets the merge run.
    expect(suspended.bound).toHaveLength(0);
    expect(repository.resolveIdentifier("storefront", "development", "anonymous_id", "a2")).toBe(
      other.profileId,
    );
  });

  it("keeps the canonical customer id when the cap refuses a new one", async () => {
    const { repository, deps } = makeDeps({ maxIdentifiersPerKind: 1 });
    const first = await handleEvent(
      deps,
      event({ identity: identity({ anonymous_id: "anon_1", customer_id: "cus_1" }) }),
    );
    expect(first.canonicalCustomerId).toBe("cus_1");

    // The same person (via anon_1) arrives claiming a SECOND customer id.
    // The per-kind cap refuses the binding — and the profile must not
    // claim a canonical customer id whose identifier row does not point
    // back at it: destinations key on this column, and the next event
    // carrying cus_2 will resolve to a DIFFERENT profile.
    const second = await handleEvent(
      deps,
      event({ identity: identity({ anonymous_id: "anon_1", customer_id: "cus_2" }) }),
    );

    expect(
      second.rejected.some((r) => r.kind === "customer_id" && r.reason === "identifier_cap"),
    ).toBe(true);
    expect(second.canonicalCustomerId).toBe("cus_1");
    expect(
      repository.resolveIdentifier("storefront", "development", "customer_id", "cus_2"),
    ).toBeUndefined();
  });
});

describe("identity stage: traits", () => {
  it("merge-patches traits from an identify event and emits profile.updated", async () => {
    const { producer, deps } = makeDeps();
    const result = await handleEvent(
      deps,
      event({
        event: "user.identified",
        identity: identity({ anonymous_id: "anon_1", customer_id: "cus_1" }),
        properties: { tier: "gold", ltv_band: "high" },
      }),
    );

    expect(result.traitsPatched).toBe(true);
    expect(producer.names(PROFILE)).toContain("profile.updated");
    const updated = producer.eventsOn(PROFILE)[0];
    const props = updated?.["properties"] as Record<string, unknown>;
    expect(props["writer"]).toBe("identity_stage");
    expect(props["traits"]).toEqual({ tier: "gold", ltv_band: "high" });
  });

  it("names the profile in the PROFILE BLOCK, not only in properties", async () => {
    // The sink reads `profile.profile_id` to fill the queue table's typed
    // column and drops the row when it is absent. This event carried the
    // id in `properties.profile_id` alone until 2026-08-18, so every
    // trait the identity stage wrote was skipped on the way to
    // `polaris.profiles` -- while the stage, the publish and the sink all
    // reported success.
    //
    // The sink's own test could not catch it: it builds the envelope by
    // hand, profile block included, so it proved the sink reads the block
    // and never that this producer writes one.
    const { producer, deps } = makeDeps();
    await handleEvent(
      deps,
      event({
        event: "user.identified",
        identity: identity({ anonymous_id: "anon_2", customer_id: "cus_2" }),
        properties: { tier: "silver" },
      }),
    );

    const updated = producer.eventsOn(PROFILE)[0];
    const block = updated?.["profile"] as Record<string, unknown> | undefined;
    const props = updated?.["properties"] as Record<string, unknown>;

    expect(block?.["profile_id"]).toEqual(expect.any(String));
    expect(String(block?.["profile_id"])).not.toBe("");
    // And it agrees with the copy in properties, which readers still use.
    expect(block?.["profile_id"]).toBe(props["profile_id"]);
  });

  it("ignores traits on non-identify events, keeping one serialized writer", async () => {
    const { producer, deps } = makeDeps();
    const result = await handleEvent(
      deps,
      event({
        event: "checkout.started",
        identity: identity({ customer_id: "cus_1" }),
        properties: { tier: "smuggled" },
      }),
    );

    expect(result.traitsPatched).toBe(false);
    expect(producer.eventsOn(PROFILE)).toHaveLength(0);
  });

  it("keeps the identity link when traits exceed the size guard", async () => {
    const { producer, deps } = makeDeps({ maxTraitsBytes: 32 });
    const result = await handleEvent(
      deps,
      event({
        event: "user.identified",
        identity: identity({ anonymous_id: "anon_1", customer_id: "cus_1" }),
        properties: { blob: "x".repeat(500) },
      }),
    );

    // Losing an identity link over a payload-size problem would be the
    // worse failure, so the binding happens and only the traits drop.
    expect(result.profileId).not.toBeNull();
    expect(result.canonicalCustomerId).toBe("cus_1");
    expect(result.traitsPatched).toBe(false);
    expect(producer.eventsOn(PROFILE)).toHaveLength(0);
    expect(producer.eventsOn(IDENTIFIED)).toHaveLength(1);
  });
});

describe("identity stage: commit-before-publish", () => {
  it("publishes nothing when the transaction fails", async () => {
    // THE ordering invariant. The enrichment stage reads `profiles` by the
    // id this stage stamps, so a spine event must never exist for a
    // profile the database does not have. Publishing first would open
    // exactly that window, and no amount of partition ordering closes it
    // — the two stages are separate processes against one database.
    const producer = new RecordingProducer();
    const failing = {
      resolveProfile: async () => {
        throw new Error("deadlock detected");
      },
    };
    const deps = {
      repository: failing,
      producer,
      isolation: sharedOnlyIsolationLookup,
      logger: silentLogger,
      policyFor: () => BASE_POLICY,
      runId: () => "run_1",
      now: () => new Date("2026-08-14T00:00:00.000Z"),
    };

    await expect(
      handleEvent(deps, event({ identity: identity({ anonymous_id: "anon_1" }) })),
    ).rejects.toThrow("deadlock detected");

    // Nothing reached the broker, so redelivery re-runs the whole
    // transaction cleanly rather than reconciling a half-published state.
    expect(producer.published).toHaveLength(0);
  });

  it("emits the spine event before the derived facts", async () => {
    // The spine is what lets the pipeline make progress; the facts are
    // bookkeeping. If a derived publish fails, redelivery re-runs an
    // idempotent transaction and re-emits deterministic ids.
    const { producer, deps } = makeDeps();
    await handleEvent(
      deps,
      event({
        event: "user.identified",
        identity: identity({ anonymous_id: "anon_1", customer_id: "cus_1" }),
        properties: { tier: "gold" },
      }),
    );

    const families = producer.published.map((p) => p.family);
    expect(families[0]).toBe(IDENTIFIED);
    expect(families.slice(1).every((f) => f !== IDENTIFIED)).toBe(true);
  });
});
