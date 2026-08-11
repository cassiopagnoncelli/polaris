import { describe, expect, it } from "vitest";

import { InMemoryCheckpointStore } from "../src/checkpoints.js";

describe("InMemoryCheckpointStore", () => {
  it("round-trips a checkpoint per (group, stream)", async () => {
    const store = new InMemoryCheckpointStore();
    await store.write({ group_name: "g1", stream: "raw.events-0", last_offset: "10" });
    await store.write({ group_name: "g2", stream: "raw.events-0", last_offset: "99" });

    expect(await store.read("g1", "raw.events-0")).toBe("10");
    expect(await store.read("g2", "raw.events-0")).toBe("99");
  });

  it("returns undefined for an unknown stream so the start position applies", async () => {
    const store = new InMemoryCheckpointStore();
    // `undefined` must mean "use the configured start position", never
    // "start at offset 0" — those differ by a whole retention window.
    expect(await store.read("g", "raw.events-0")).toBeUndefined();
  });

  it("never moves a checkpoint backwards", async () => {
    const store = new InMemoryCheckpointStore();
    await store.write({ group_name: "g", stream: "raw.events-0", last_offset: "50" });
    await store.write({ group_name: "g", stream: "raw.events-0", last_offset: "20" });

    // A straggler reader overlapping a newer one must not rewind it.
    expect(await store.read("g", "raw.events-0")).toBe("50");
  });

  it("handles offsets beyond Number.MAX_SAFE_INTEGER", async () => {
    const store = new InMemoryCheckpointStore();
    await store.write({
      group_name: "g",
      stream: "raw.events-0",
      last_offset: "9007199254740993",
    });
    await store.write({
      group_name: "g",
      stream: "raw.events-0",
      last_offset: "9007199254740992",
    });

    expect(await store.read("g", "raw.events-0")).toBe("9007199254740993");
  });

  it("reads every stream for a group, and only that group", async () => {
    const store = new InMemoryCheckpointStore();
    await store.write({ group_name: "g", stream: "raw.events-0", last_offset: "1" });
    await store.write({ group_name: "g", stream: "raw.events-1", last_offset: "2" });
    await store.write({ group_name: "other", stream: "raw.events-0", last_offset: "3" });

    expect(await store.readAll("g")).toEqual(
      new Map([
        ["raw.events-0", "1"],
        ["raw.events-1", "2"],
      ]),
    );
  });
});
