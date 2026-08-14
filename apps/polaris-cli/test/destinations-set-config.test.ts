/**
 * `polaris destinations set-config`.
 *
 * `destinations.config` had no write path before this command: the column
 * existed, the destination runtime read it for the routing gate, and the only
 * way to set it was direct SQL. These tests pin the two things that path was
 * missing — a mapping guard and a validity check — plus the property that
 * makes both worth having: a refusal writes NOTHING.
 */

import { describe, expect, it } from "vitest";

import { buildDestinationsSetConfigRunner } from "../src/commands/destinations/set-config.js";
import type { CommandContext } from "../src/command.js";

const ROW = {
  destination_id: "polaris_dst_1",
  project_id: "storefront",
  environment: "production",
  vendor: "webhook",
  instance_label: "team-a",
  status: "active",
  mode: "live",
  config: {},
} as never;

function recordingStore() {
  const writes: Array<Readonly<Record<string, unknown>>> = [];
  return {
    writes,
    store: {
      findById: async () => ROW,
      setConfigWithAudit: async (
        _id: string,
        config: Readonly<Record<string, unknown>>,
      ): Promise<boolean> => {
        writes.push(config);
        return true;
      },
      close: async () => {},
    },
  };
}

function makeContext(): CommandContext {
  return {
    actor: { source: "cli", label: "tester" },
    config: { output: "json" },
    output: { writeOut: () => {}, writeErr: () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    env: {},
  } as unknown as CommandContext;
}

const BASE = { destinationId: "polaris_dst_1", reason: "test" };

describe("destinations set-config", () => {
  it("replaces the whole bag", async () => {
    const { store, writes } = recordingStore();
    const runner = buildDestinationsSetConfigRunner({ openStore: () => store });
    await runner(
      { ...BASE, config: JSON.stringify({ routing: { subscriptions: { events: ["a.b"] } } }) },
      makeContext(),
    );
    expect(writes).toEqual([{ routing: { subscriptions: { events: ["a.b"] } } }]);
  });

  it("clears the bag with an empty object", async () => {
    // How an instance goes back to inheriting the project's settings. A merge
    // semantics would make this unexpressible.
    const { store, writes } = recordingStore();
    const runner = buildDestinationsSetConfigRunner({ openStore: () => store });
    await runner({ ...BASE, config: "{}" }, makeContext());
    expect(writes).toEqual([{}]);
  });

  it("refuses a mapping-shaped key and writes nothing", async () => {
    // The reason this command exists at all. `project_config` has been
    // guarded at its write path since it shipped; an unguarded
    // `destinations.config` was the last place a field map could be stored.
    const { store, writes } = recordingStore();
    const runner = buildDestinationsSetConfigRunner({ openStore: () => store });
    for (const key of ["field_map", "event_map", "routing_map"]) {
      await expect(
        runner({ ...BASE, config: JSON.stringify({ [key]: { a: "b" } }) }, makeContext()),
      ).rejects.toThrow();
    }
    expect(writes).toHaveLength(0);
  });

  it("refuses a routing value the gate would silently ignore", async () => {
    // The gate degrades to "unconfigured" on a value it cannot parse. That is
    // right at delivery time — a typo must not mute a destination — and it is
    // exactly why the typo has to be caught here instead.
    const { store, writes } = recordingStore();
    const runner = buildDestinationsSetConfigRunner({ openStore: () => store });
    await expect(
      runner(
        { ...BASE, config: JSON.stringify({ routing: { filters: "not a list" } }) },
        makeContext(),
      ),
    ).rejects.toThrow(/routing gate configuration/);
    expect(writes).toHaveLength(0);
  });

  it("lets an unknown key through", async () => {
    // The bag is read in strip mode by design: a project may carry a key a
    // newer consumer will read. Refusing here would make the CLI the reason a
    // rollout has to happen in a particular order.
    const { store, writes } = recordingStore();
    const runner = buildDestinationsSetConfigRunner({ openStore: () => store });
    await runner({ ...BASE, config: JSON.stringify({ future_knob: 1 }) }, makeContext());
    expect(writes).toEqual([{ future_knob: 1 }]);
  });

  it("requires a reason and valid JSON", async () => {
    const { store, writes } = recordingStore();
    const runner = buildDestinationsSetConfigRunner({ openStore: () => store });
    await expect(
      runner({ destinationId: "polaris_dst_1", config: "{}" }, makeContext()),
    ).rejects.toThrow(/--reason/);
    await expect(runner({ ...BASE, config: "not json" }, makeContext())).rejects.toThrow(
      /valid JSON/,
    );
    await expect(runner({ ...BASE, config: "[]" }, makeContext())).rejects.toThrow(/JSON object/);
    expect(writes).toHaveLength(0);
  });
});
