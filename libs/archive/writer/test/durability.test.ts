/**
 * The property the archive turns on: a crash loses nothing.
 *
 * These tests are the acceptance criterion. Everything else in the
 * package — the layout, the manifest, the S3 adapter — is machinery in
 * service of one claim: the consumer's checkpoint never advances past
 * what is in object storage, so whatever a crash discards is redelivered.
 */

import type { Checkpoint, CheckpointStore } from "@polaris/bus";
import { describe, expect, it } from "vitest";
import {
  ArchiveBatcher,
  createArchiveWriter,
  createDeferredCheckpointStore,
  createInMemoryArchiveStore,
  parseArchiveBatchKey,
} from "../src/index.js";

const LIMITS = { maxBytes: 1_000_000, maxRecords: 3, maxAgeMs: 60_000 };
const PREFIX = "polaris";
const STREAM = "raw.events-0";

function record(offset: number, occurredAt = "2026-08-15T10:00:00.000Z") {
  const line = JSON.stringify({
    event_id: `evt-${String(offset)}`,
    event: "purchase",
    project_id: "storefront",
    environment: "production",
    occurred_at: occurredAt,
  });
  return {
    projectId: "storefront",
    environment: "production",
    date: occurredAt.slice(0, 10),
    stream: STREAM,
    offset: String(offset),
    line,
  };
}

/** A checkpoint store that records what it was actually asked to persist. */
function spyStore(): CheckpointStore & { readonly writes: Checkpoint[] } {
  const writes: Checkpoint[] = [];
  return {
    writes,
    async read() {
      return undefined;
    },
    async readAll() {
      return new Map();
    },
    async write(checkpoint) {
      writes.push(checkpoint);
    },
  };
}

describe("the checkpoint never outruns the archive", () => {
  it("skips the write entirely when the stream is unknown", async () => {
    // Nothing has ever been seen on this stream, so there is no durable
    // position to clamp to. Writing 0 would be worse than writing
    // nothing: on the next restart the consumer would rewind to the start
    // of the stream and re-archive everything still in retention.
    const batcher = new ArchiveBatcher(LIMITS);
    const inner = spyStore();
    const store = createDeferredCheckpointStore({
      inner,
      durableOffset: (stream) => batcher.durableOffset(stream),
    });

    await store.write({ group_name: "g", stream: STREAM, last_offset: "1" });

    expect(inner.writes).toEqual([]);
  });

  it("clamps to one below the lowest pending offset before any flush", async () => {
    // The watermark is a PREFIX claim: with offset 500 buffered and
    // nothing flushed, everything below 500 is durable-or-never-seen, and
    // resuming at 500 is exactly right. This is what lets a consumer that
    // attached at the tail checkpoint at all — the alternative is a
    // checkpoint frozen at "unknown" until the first flush, which after a
    // crash replays from wherever the consumer's start position lands.
    const batcher = new ArchiveBatcher(LIMITS);
    const inner = spyStore();
    const store = createDeferredCheckpointStore({
      inner,
      durableOffset: (stream) => batcher.durableOffset(stream),
    });

    batcher.add(record(500), 0);
    await store.write({ group_name: "g", stream: STREAM, last_offset: "500" });

    expect(inner.writes).toEqual([{ group_name: "g", stream: STREAM, last_offset: "499" }]);
  });

  it("has no durable position at all when offset 0 itself is pending", () => {
    // There is no "one below offset 0", and 0 is a real offset — so the
    // honest answer is that nothing is durable.
    const batcher = new ArchiveBatcher(LIMITS);
    batcher.add(record(0), 0);

    expect(batcher.durableOffset(STREAM)).toBeUndefined();
  });

  it("clamps to the last flushed offset while a batch is still buffered", async () => {
    const batcher = new ArchiveBatcher(LIMITS);
    const objects = createInMemoryArchiveStore();
    const writer = createArchiveWriter({
      store: objects,
      batcher,
      prefix: PREFIX,
      now: () => new Date("2026-08-15T10:05:00.000Z"),
    });
    const inner = spyStore();
    const checkpoints = createDeferredCheckpointStore({
      inner,
      durableOffset: (stream) => batcher.durableOffset(stream),
    });

    // Three records fill the batch (maxRecords: 3) and flush.
    for (const offset of [1, 2, 3]) batcher.add(record(offset), 0);
    await writer.flush(0);
    // Two more arrive and are still only in memory.
    for (const offset of [4, 5]) batcher.add(record(offset), 0);

    // The consumer believes it has handled through offset 5.
    await checkpoints.write({ group_name: "g", stream: STREAM, last_offset: "5" });

    expect(inner.writes).toEqual([{ group_name: "g", stream: STREAM, last_offset: "3" }]);
  });

  it("loses nothing across a crash: what the checkpoint claims, the archive holds", async () => {
    const batcher = new ArchiveBatcher(LIMITS);
    const objects = createInMemoryArchiveStore();
    const writer = createArchiveWriter({
      store: objects,
      batcher,
      prefix: PREFIX,
      now: () => new Date("2026-08-15T10:05:00.000Z"),
    });
    const inner = spyStore();
    const checkpoints = createDeferredCheckpointStore({
      inner,
      durableOffset: (stream) => batcher.durableOffset(stream),
    });

    // Seven events arrive; the consumer checkpoints after each.
    for (const offset of [1, 2, 3, 4, 5, 6, 7]) {
      batcher.add(record(offset), 0);
      await writer.flush(0);
      await checkpoints.write({
        group_name: "g",
        stream: STREAM,
        last_offset: String(offset),
      });
    }
    // ...and then the process dies. Offset 7 is in RAM: 1-3 and 4-6 were
    // full batches, 7 opened a new one.

    const lastCheckpoint = inner.writes.at(-1)?.last_offset;
    expect(lastCheckpoint).toBe("6");

    // Every offset the checkpoint claims is genuinely in an object.
    const archived = new Set<string>();
    for (const [key, body] of objects.objects) {
      if (parseArchiveBatchKey(PREFIX, key) === null) continue;
      for (const line of body.trim().split("\n")) {
        archived.add(String((JSON.parse(line) as { event_id: string }).event_id));
      }
    }
    for (let offset = 1; offset <= Number(lastCheckpoint); offset += 1) {
      expect(archived.has(`evt-${String(offset)}`)).toBe(true);
    }
    // Offset 7 is not archived — and the checkpoint does not claim it, so
    // the stream redelivers it.
    expect(archived.has("evt-7")).toBe(false);
  });

  it("holds the watermark back when a put fails, and releases it on the retry", async () => {
    const batcher = new ArchiveBatcher(LIMITS);
    const objects = createInMemoryArchiveStore();
    let failNext = true;
    const flaky = {
      ...objects,
      async put(input: { key: string; body: string }) {
        if (failNext && !input.key.includes("_manifest")) {
          failNext = false;
          throw new Error("s3 unavailable");
        }
        await objects.put(input);
      },
    };
    const writer = createArchiveWriter({
      store: flaky,
      batcher,
      prefix: PREFIX,
      now: () => new Date("2026-08-15T10:05:00.000Z"),
    });

    for (const offset of [1, 2, 3]) batcher.add(record(offset), 0);
    const failedRun = await writer.flush(0);
    expect(failedRun.batchesFailed).toBe(1);
    // The batch is pending again, so the watermark is pinned below it —
    // offsets 1-3 stay replayable however many times the put fails.
    expect(batcher.durableOffset(STREAM)).toBe("0");

    // The failed batch is immediately due again — it kept its open time.
    const retry = await writer.flush(1);
    expect(retry.objectsWritten).toBe(1);
    expect(batcher.durableOffset(STREAM)).toBe("3");
  });

  it("a pending low batch holds the watermark even when later offsets are written", async () => {
    // Durability is a property of a PREFIX of the stream. A checkpoint at
    // offset 200 asserts everything below it was handled, so one pending
    // batch at 40 pins the watermark at 39 no matter what came after.
    const batcher = new ArchiveBatcher({ maxBytes: 1_000_000, maxRecords: 2, maxAgeMs: 60_000 });
    const objects = createInMemoryArchiveStore();
    const writer = createArchiveWriter({
      store: objects,
      batcher,
      prefix: PREFIX,
      now: () => new Date("2026-08-15T10:05:00.000Z"),
    });

    // Offset 40 lands on one day, 41-42 on another, so they are different
    // batches and the later one fills first.
    batcher.add(record(40, "2026-08-15T23:59:59.000Z"), 0);
    batcher.add(record(41, "2026-08-16T00:00:01.000Z"), 0);
    batcher.add(record(42, "2026-08-16T00:00:02.000Z"), 0);
    await writer.flush(0);

    expect(batcher.durableOffset(STREAM)).toBe("39");
  });
});

describe("flush", () => {
  it("does not overlap: a concurrent call joins the run in progress", async () => {
    // Two flushes at once would read-modify-write the same manifest and
    // lose a line.
    const batcher = new ArchiveBatcher(LIMITS);
    const objects = createInMemoryArchiveStore();
    let puts = 0;
    const counting = {
      ...objects,
      async put(input: { key: string; body: string }) {
        puts += 1;
        await objects.put(input);
      },
    };
    const writer = createArchiveWriter({
      store: counting,
      batcher,
      prefix: PREFIX,
      now: () => new Date("2026-08-15T10:05:00.000Z"),
    });

    for (const offset of [1, 2, 3]) batcher.add(record(offset), 0);
    const [a, b] = await Promise.all([writer.flush(0), writer.flush(0)]);

    expect(a).toBe(b);
    // One object plus one manifest, not two of each.
    expect(puts).toBe(2);
  });

  it("force closes a partial batch, so shutdown does not discard buffered events", async () => {
    const batcher = new ArchiveBatcher(LIMITS);
    const objects = createInMemoryArchiveStore();
    const writer = createArchiveWriter({
      store: objects,
      batcher,
      prefix: PREFIX,
      now: () => new Date("2026-08-15T10:05:00.000Z"),
    });

    batcher.add(record(1), 0);
    expect((await writer.flush(0)).objectsWritten).toBe(0);
    expect((await writer.flush(0, true)).objectsWritten).toBe(1);
  });

  it("closes a batch on age even when it is nowhere near full", async () => {
    // Without the age bound, a low-traffic project's checkpoint stands
    // still until it accumulates enough events to fill a batch — which on
    // fifty events a day is a fortnight.
    const batcher = new ArchiveBatcher({
      maxBytes: 1_000_000,
      maxRecords: 10_000,
      maxAgeMs: 5_000,
    });
    const objects = createInMemoryArchiveStore();
    const writer = createArchiveWriter({
      store: objects,
      batcher,
      prefix: PREFIX,
      now: () => new Date("2026-08-15T10:05:00.000Z"),
    });

    batcher.add(record(1), 1_000);
    expect((await writer.flush(4_000)).objectsWritten).toBe(0);
    expect((await writer.flush(6_001)).objectsWritten).toBe(1);
  });
});
