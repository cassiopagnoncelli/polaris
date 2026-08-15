/**
 * `polaris traits compute`.
 *
 * The failure worth guarding is quiet: a cron line with a typo'd trait name
 * that succeeds nightly, computes nothing, and reports success — leaving the
 * job green and the trait months stale.
 */

import { describe, expect, it } from "vitest";

import type { CommandContext } from "../src/command.js";
import { buildTraitsComputeRunner } from "../src/commands/traits/compute.js";
import { createTraitEventEmitter } from "../src/commands/traits/emitter.js";
import { buildRegisteredTraitsRunner } from "../src/commands/traits/registration.js";

function makeContext(captured: string[]): CommandContext {
  return {
    actor: { source: "cli", label: "tester" },
    config: { output: "json" },
    output: { writeOut: (line: string) => captured.push(line), writeErr: () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    env: {},
  } as unknown as CommandContext;
}

function stubRunner(seen: Array<ReadonlyArray<{ key: string }>>) {
  return () => ({
    run: async (input: { traits: ReadonlyArray<{ key: string; sql: string }> }) => {
      seen.push(input.traits.map((t) => ({ key: t.key })));
      return {
        profilesChanged: 1,
        perTrait: input.traits.map((t) => ({ key: t.key, computed: 1, changed: 1, removed: 0 })),
      };
    },
  });
}

const BASE = { project: "storefront", env: "production" };

describe("traits compute", () => {
  it("runs every defined trait by default", async () => {
    const seen: Array<ReadonlyArray<{ key: string }>> = [];
    const runner = buildTraitsComputeRunner({ runner: stubRunner(seen) });
    await runner(BASE, makeContext([]));
    expect(seen[0]?.map((t) => t.key)).toContain("orders_30d");
  });

  it("narrows to one definition with --trait", async () => {
    const seen: Array<ReadonlyArray<{ key: string }>> = [];
    const runner = buildTraitsComputeRunner({ runner: stubRunner(seen) });
    await runner({ ...BASE, trait: "orders_30d" }, makeContext([]));
    expect(seen[0]).toEqual([{ key: "orders_30d" }]);
  });

  it("REFUSES an unknown trait rather than running nothing", async () => {
    // The quiet failure. An empty run would exit zero, and a nightly cron
    // line with a typo would stay green while the trait went stale.
    const seen: Array<ReadonlyArray<{ key: string }>> = [];
    const runner = buildTraitsComputeRunner({ runner: stubRunner(seen) });
    await expect(runner({ ...BASE, trait: "orders_30dd" }, makeContext([]))).rejects.toThrow(
      /unknown trait "orders_30dd"/,
    );
    expect(seen).toHaveLength(0);
  });

  it("names the defined traits when it refuses", async () => {
    // An operator who typo'd needs the list, not just a rejection.
    const runner = buildTraitsComputeRunner({ runner: stubRunner([]) });
    await expect(runner({ ...BASE, trait: "nope" }, makeContext([]))).rejects.toThrow(/orders_30d/);
  });

  it("requires project and env", async () => {
    const runner = buildTraitsComputeRunner({ runner: stubRunner([]) });
    await expect(runner({ env: "production" }, makeContext([]))).rejects.toThrow(/--project/);
    await expect(runner({ project: "x" }, makeContext([]))).rejects.toThrow(/--env/);
  });

  it("reports per-trait counts so a no-op run is visibly a no-op", async () => {
    const captured: string[] = [];
    const runner = buildTraitsComputeRunner({ runner: stubRunner([]) });
    await runner(BASE, makeContext(captured));
    const parsed = JSON.parse(captured.join(""));
    expect(parsed.traits[0]).toMatchObject({ key: "orders_30d", computed: 1, changed: 1 });
    expect(parsed.profiles_changed).toBe(1);
  });
});

describe("registered traits runner", () => {
  it("refuses without a ClickHouse URL", () => {
    // The crontab lines point at this command. Without the cluster it reads
    // projections from, a scheduled run would fail nightly into a log nobody
    // reads until the trait is months stale — so it fails loudly at
    // construction with the variable named.
    const ctx = {
      env: {},
      actor: { source: "cli", label: "tester" },
      logger: { info: () => {} },
    } as unknown as Parameters<typeof buildRegisteredTraitsRunner>[0];

    expect(() => buildRegisteredTraitsRunner(ctx)).toThrow(/POLARIS_CLICKHOUSE_URL is required/);
  });
});

describe("trait event emitter", () => {
  it("derives ids per (run, profile) so a restarted run collapses", async () => {
    // A traits run has no source event to derive from. Deriving from
    // (runId, profileId) makes a re-run of the SAME run produce the same
    // ids, which ReplacingMergeTree collapses — rather than double-counting
    // a nightly job somebody restarted.
    const published: Array<{ event: Record<string, unknown> }> = [];
    const emitter = createTraitEventEmitter({
      producer: {
        publishEvent: async (input: { event: Record<string, unknown> }) => {
          published.push({ event: input.event });
          return { stream: "profile.events-0", partition: 0 };
        },
      } as never,
      isolation: { isIsolated: () => false },
      now: () => new Date("2026-08-15T03:35:00.000Z"),
    });

    const update = {
      projectId: "storefront",
      environment: "production",
      profileId: "01930000-0000-7000-8000-0000000000aa",
      traitsVersion: 7,
      traits: { orders_30d: 3 },
      removedKeys: [],
      runId: "run-1",
    };
    await emitter.profileUpdated(update);
    await emitter.profileUpdated(update);

    expect(published[0]?.event["event_id"]).toBe(published[1]?.event["event_id"]);
  });

  it("gives a different run different ids", async () => {
    // A new run genuinely observed different values, so it is a new fact.
    const published: Array<Record<string, unknown>> = [];
    const emitter = createTraitEventEmitter({
      producer: {
        publishEvent: async (input: { event: Record<string, unknown> }) => {
          published.push(input.event);
          return { stream: "profile.events-0", partition: 0 };
        },
      } as never,
      isolation: { isIsolated: () => false },
      now: () => new Date("2026-08-15T03:35:00.000Z"),
    });

    const base = {
      projectId: "storefront",
      environment: "production",
      profileId: "01930000-0000-7000-8000-0000000000aa",
      traitsVersion: 7,
      traits: { orders_30d: 3 },
      removedKeys: [],
    };
    await emitter.profileUpdated({ ...base, runId: "run-1" });
    await emitter.profileUpdated({ ...base, runId: "run-2" });

    expect(published[0]?.["event_id"]).not.toBe(published[1]?.["event_id"]);
  });

  it("stamps writer=computed_traits and carries removed keys", async () => {
    // `profile.updated`'s schema has carried this writer enum since it
    // shipped; this is the writer that makes the third value real.
    const published: Array<Record<string, unknown>> = [];
    const emitter = createTraitEventEmitter({
      producer: {
        publishEvent: async (input: { event: Record<string, unknown> }) => {
          published.push(input.event);
          return { stream: "profile.events-0", partition: 0 };
        },
      } as never,
      isolation: { isIsolated: () => false },
      now: () => new Date("2026-08-15T03:35:00.000Z"),
    });

    await emitter.profileUpdated({
      projectId: "storefront",
      environment: "production",
      profileId: "01930000-0000-7000-8000-0000000000aa",
      traitsVersion: 8,
      traits: {},
      removedKeys: ["orders_30d"],
      runId: "run-1",
    });

    const props = published[0]?.["properties"] as Record<string, unknown>;
    expect(props["writer"]).toBe("computed_traits");
    expect(props["removed_keys"]).toEqual(["orders_30d"]);
  });
});
