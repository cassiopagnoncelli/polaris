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
