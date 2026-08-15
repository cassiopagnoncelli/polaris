/**
 * Reading the archive back.
 *
 * The property that matters: what the archiver wrote, the replay source
 * returns — and nothing more. Round-trip tests write through the real
 * writer rather than hand-building objects, so a layout change that broke
 * the reader could not pass by updating a fixture.
 */

import { describe, expect, it } from "vitest";

import {
  ArchiveBatcher,
  createArchiveReplaySource,
  createArchiveWriter,
  createInMemoryArchiveStore,
} from "../src/index.js";

const PREFIX = "polaris";
const SCOPE = {
  project_id: "storefront",
  environment: "production",
  event_name: null,
  event_id: null,
};

function envelope(input: {
  id: string;
  at: string;
  event?: string;
  project?: string;
  environment?: string;
}) {
  return JSON.stringify({
    event_id: input.id,
    event: input.event ?? "purchase",
    project_id: input.project ?? "storefront",
    environment: input.environment ?? "production",
    occurred_at: input.at,
  });
}

async function archive(
  events: ReadonlyArray<{
    offset: number;
    id: string;
    at: string;
    event?: string;
    project?: string;
  }>,
) {
  const store = createInMemoryArchiveStore();
  const batcher = new ArchiveBatcher({ maxBytes: 1_000_000, maxRecords: 2, maxAgeMs: 60_000 });
  const writer = createArchiveWriter({
    store,
    batcher,
    prefix: PREFIX,
    now: () => new Date("2026-08-15T12:00:00.000Z"),
  });
  for (const event of events) {
    const line = envelope({
      id: event.id,
      at: event.at,
      ...(event.event !== undefined ? { event: event.event } : {}),
      ...(event.project !== undefined ? { project: event.project } : {}),
    });
    batcher.add(
      {
        projectId: event.project ?? "storefront",
        environment: "production",
        date: event.at.slice(0, 10),
        stream: "raw.events-0",
        offset: String(event.offset),
        line,
      },
      0,
    );
  }
  await writer.flush(0, true);
  return store;
}

describe("createArchiveReplaySource", () => {
  it("returns what was archived, in offset order", async () => {
    const store = await archive([
      { offset: 1, id: "a", at: "2026-08-15T10:00:00.000Z" },
      { offset: 2, id: "b", at: "2026-08-15T10:01:00.000Z" },
      { offset: 3, id: "c", at: "2026-08-15T10:02:00.000Z" },
    ]);
    const source = createArchiveReplaySource({ store, prefix: PREFIX });

    const events = await source.fetchChunk({
      chunk: { from: "2026-08-15T00:00:00.000Z", to: "2026-08-15T23:59:59.999Z" },
      plan: SCOPE,
    });

    expect(events.map((event) => event.event_id)).toEqual(["a", "b", "c"]);
  });

  it("honours chunk bounds itself — the executor trusts what it gets", async () => {
    // An adapter that returned a day for an hour's chunk would republish
    // twenty-three hours of traffic nobody asked for.
    const store = await archive([
      { offset: 1, id: "before", at: "2026-08-15T09:59:59.000Z" },
      { offset: 2, id: "inside", at: "2026-08-15T10:30:00.000Z" },
      { offset: 3, id: "after", at: "2026-08-15T11:00:01.000Z" },
    ]);
    const source = createArchiveReplaySource({ store, prefix: PREFIX });

    const events = await source.fetchChunk({
      chunk: { from: "2026-08-15T10:00:00.000Z", to: "2026-08-15T11:00:00.000Z" },
      plan: SCOPE,
    });

    expect(events.map((event) => event.event_id)).toEqual(["inside"]);
  });

  it("filters to plan scope", async () => {
    const store = await archive([
      { offset: 1, id: "mine", at: "2026-08-15T10:00:00.000Z" },
      { offset: 2, id: "theirs", at: "2026-08-15T10:00:00.000Z", project: "other" },
      { offset: 3, id: "wrong-event", at: "2026-08-15T10:00:00.000Z", event: "pageview" },
    ]);
    const source = createArchiveReplaySource({ store, prefix: PREFIX });

    const events = await source.fetchChunk({
      chunk: { from: "2026-08-15T00:00:00.000Z", to: "2026-08-15T23:59:59.999Z" },
      plan: { ...SCOPE, event_name: "purchase" },
    });

    expect(events.map((event) => event.event_id)).toEqual(["mine"]);
  });

  it("crosses a day boundary", async () => {
    const store = await archive([
      { offset: 1, id: "late", at: "2026-08-15T23:59:00.000Z" },
      { offset: 2, id: "early", at: "2026-08-16T00:01:00.000Z" },
    ]);
    const source = createArchiveReplaySource({ store, prefix: PREFIX });

    const events = await source.fetchChunk({
      chunk: { from: "2026-08-15T23:00:00.000Z", to: "2026-08-16T01:00:00.000Z" },
      plan: SCOPE,
    });

    expect(events.map((event) => event.event_id)).toEqual(["late", "early"]);
  });

  it("skips objects whose manifest range misses the chunk", async () => {
    // The manifest's whole job: not downloading a day to find an hour.
    const store = await archive([
      { offset: 1, id: "morning-a", at: "2026-08-15T09:00:00.000Z" },
      { offset: 2, id: "morning-b", at: "2026-08-15T09:01:00.000Z" },
      { offset: 3, id: "evening-a", at: "2026-08-15T21:00:00.000Z" },
      { offset: 4, id: "evening-b", at: "2026-08-15T21:01:00.000Z" },
    ]);
    const fetched: string[] = [];
    const counting = {
      ...store,
      async get(key: string) {
        fetched.push(key);
        return store.get(key);
      },
    };
    const source = createArchiveReplaySource({ store: counting, prefix: PREFIX });

    const events = await source.fetchChunk({
      chunk: { from: "2026-08-15T20:00:00.000Z", to: "2026-08-15T22:00:00.000Z" },
      plan: SCOPE,
    });

    expect(events.map((event) => event.event_id)).toEqual(["evening-a", "evening-b"]);
    // The morning object was never downloaded.
    expect(fetched.filter((key) => key.includes("/raw.events-0/"))).toHaveLength(1);
  });

  it("falls back to listing when the manifest is missing, rather than reporting no data", async () => {
    // An archive written before manifests existed — or a flush that put
    // the object and died before its manifest line — must still replay
    // completely. Silently returning nothing here is indistinguishable
    // from a window with no events.
    const store = await archive([
      { offset: 1, id: "a", at: "2026-08-15T10:00:00.000Z" },
      { offset: 2, id: "b", at: "2026-08-15T10:01:00.000Z" },
    ]);
    for (const key of [...store.objects.keys()]) {
      if (key.includes("_manifest")) store.objects.delete(key);
    }
    const missing: string[] = [];
    const source = createArchiveReplaySource({
      store,
      prefix: PREFIX,
      onManifestMissing: ({ date }) => missing.push(date),
    });

    const events = await source.fetchChunk({
      chunk: { from: "2026-08-15T00:00:00.000Z", to: "2026-08-15T23:59:59.999Z" },
      plan: SCOPE,
    });

    expect(events.map((event) => event.event_id)).toEqual(["a", "b"]);
    expect(missing).toEqual(["2026-08-15"]);
  });

  it("ignores unparseable lines instead of failing the chunk", async () => {
    const store = await archive([{ offset: 1, id: "good", at: "2026-08-15T10:00:00.000Z" }]);
    for (const [key, body] of store.objects) {
      if (key.includes("_manifest")) continue;
      store.objects.set(key, `${body}{ this is not json\n`);
    }
    const source = createArchiveReplaySource({ store, prefix: PREFIX });

    const events = await source.fetchChunk({
      chunk: { from: "2026-08-15T00:00:00.000Z", to: "2026-08-15T23:59:59.999Z" },
      plan: SCOPE,
    });

    expect(events.map((event) => event.event_id)).toEqual(["good"]);
  });

  it("falls back to the event id when the envelope carries no partition key", async () => {
    // A republish without a key lands on partition 0 and breaks ordering
    // for everything already there.
    const store = await archive([{ offset: 1, id: "a", at: "2026-08-15T10:00:00.000Z" }]);
    const source = createArchiveReplaySource({ store, prefix: PREFIX });

    const [event] = await source.fetchChunk({
      chunk: { from: "2026-08-15T00:00:00.000Z", to: "2026-08-15T23:59:59.999Z" },
      plan: SCOPE,
    });

    expect(event?.partition_key).toBe("a");
  });
});

describe("coveredDates", () => {
  it("lists the days the archive holds, in one delimiter listing", async () => {
    const store = await archive([
      { offset: 1, id: "a", at: "2026-08-13T10:00:00.000Z" },
      { offset: 2, id: "b", at: "2026-08-15T10:00:00.000Z" },
      { offset: 3, id: "c", at: "2026-08-16T10:00:00.000Z" },
    ]);
    const source = createArchiveReplaySource({ store, prefix: PREFIX });

    expect(
      await source.coveredDates({ projectId: "storefront", environment: "production" }),
    ).toEqual(["2026-08-13", "2026-08-15", "2026-08-16"]);
  });

  it("is empty for a project the archive has never seen", async () => {
    const store = createInMemoryArchiveStore();
    const source = createArchiveReplaySource({ store, prefix: PREFIX });

    expect(await source.coveredDates({ projectId: "nobody", environment: "production" })).toEqual(
      [],
    );
  });
});
