import { describe, expect, it } from "vitest";

import { DeferredCheckpointStore, InMemoryCheckpointStore } from "../src/checkpoints.js";

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

describe("DeferredCheckpointStore — cross-partition isolation", () => {
  it("does not commit a position written after the snapshot was taken", async () => {
    // The regression. The owner holds ONE store across every partition it
    // reads. `commit()` used to drain the whole pending map, so a position
    // written by another partition DURING the owner's flush was persisted
    // alongside it — for a row still only in memory. A crash there loses the
    // row under a checkpoint claiming it was handled.
    const inner = new InMemoryCheckpointStore();
    const deferred = new DeferredCheckpointStore(inner);

    // Partition 0's rows are buffered and about to be flushed.
    await deferred.write({ group_name: "g", stream: "analytics.events-0", last_offset: "10" });

    // Owner swaps its buffers and snapshots the positions in the same breath.
    const held = deferred.take();

    // Partition 1 hands a message to the transport while the INSERT is in
    // flight. Its row is buffered, NOT durable.
    await deferred.write({ group_name: "g", stream: "analytics.events-1", last_offset: "77" });

    await deferred.commit(held);

    expect(await inner.read("g", "analytics.events-0")).toBe("10");
    // The whole point: partition 1's position must not have been persisted.
    expect(await inner.read("g", "analytics.events-1")).toBeUndefined();
    // It is still held, so the next flush commits it.
    expect(deferred.pendingSize()).toBe(1);
  });

  it("restores a failed batch without lowering a newer position", async () => {
    const inner = new InMemoryCheckpointStore();
    const deferred = new DeferredCheckpointStore(inner);

    await deferred.write({ group_name: "g", stream: "s", last_offset: "10" });
    const held = deferred.take();
    // The next batch already advanced this stream further.
    await deferred.write({ group_name: "g", stream: "s", last_offset: "20" });

    deferred.restore(held);
    await deferred.commit(deferred.take());

    expect(await inner.read("g", "s")).toBe("20");
  });

  it("re-reads a failed batch's rows after restore", async () => {
    const inner = new InMemoryCheckpointStore();
    const deferred = new DeferredCheckpointStore(inner);

    await deferred.write({ group_name: "g", stream: "s", last_offset: "10" });
    const held = deferred.take();
    deferred.restore(held); // INSERT threw
    expect(await inner.read("g", "s")).toBeUndefined();

    await deferred.commit(deferred.take()); // retry succeeded
    expect(await inner.read("g", "s")).toBe("10");
  });
});
