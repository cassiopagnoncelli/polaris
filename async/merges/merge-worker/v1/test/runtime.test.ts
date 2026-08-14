/**
 * The worker's wiring: which events it acts on, and what it does when the
 * store or the payload misbehaves.
 *
 * `merge-map.test.ts` covers the mapping decision itself. What can only be
 * tested here is that a normal `profile.events` stream — which also carries
 * `profile.created` and `profile.updated` — does not make this worker throw.
 */

import { ProcessorMetrics } from "@polaris/shared-processor";
import type { TransportMessagePayload } from "@polaris/shared-transport";
import { describe, expect, it } from "vitest";

import type { ExistingChain, MergeMapRow } from "../src/merge-map.js";
import { createMergeHandler, type MergeMapStore } from "../src/runtime.js";

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => noopLogger,
} as never;

const IDENTITY = { processor_name: "merge-worker", processor_version: "v1" };

function fakeStore(chained: readonly ExistingChain[] = []) {
  const writes: MergeMapRow[][] = [];
  const store: MergeMapStore = {
    chainedInto: async () => chained,
    upsert: async (rows) => {
      writes.push([...rows]);
    },
  };
  return { store, writes };
}

function payload(event: string, properties: Record<string, unknown>): TransportMessagePayload {
  return {
    stream: "profile.events-0",
    family: "profile.events",
    partition: 0,
    message: {
      value: Buffer.from(
        JSON.stringify({
          event_id: "0193e000-0000-7000-8000-00000000000e",
          event,
          schema_version: 2,
          project_id: "storefront",
          environment: "production",
          occurred_at: "2026-08-14T12:00:00.000Z",
          properties,
        }),
        "utf8",
      ),
      headers: {},
      key: null,
      offset: "1",
      timestamp: "0",
      redelivered: false,
    },
  } as TransportMessagePayload;
}

const MERGE_PROPS = {
  winner_profile_id: "0193b000-0000-7000-8000-00000000000b",
  loser_profile_id: "0193a000-0000-7000-8000-00000000000a",
  merge_id: "0193d000-0000-7000-8000-00000000000d",
  identifiers_moved: 2,
  source_event_id: "0193f000-0000-7000-8000-00000000000f",
  reason: "identifiers co-occurred on one event",
  run_id: "run-1",
};

describe("merge worker handler", () => {
  it("writes the map for identity.merged", async () => {
    const { store, writes } = fakeStore();
    const handle = createMergeHandler({
      store,
      logger: noopLogger,
      metrics: new ProcessorMetrics(),
      identity: IDENTITY,
    });
    await handle(payload("identity.merged", MERGE_PROPS));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0]).toMatchObject({
      loser_profile_id: MERGE_PROPS.loser_profile_id,
      winner_profile_id: MERGE_PROPS.winner_profile_id,
    });
  });

  it("ignores the other events on the family without erroring", async () => {
    // `profile.events` also carries profile.created and profile.updated. A
    // worker that treated an unrecognised event as a failure would fail on
    // ordinary traffic.
    const { store, writes } = fakeStore();
    const handle = createMergeHandler({
      store,
      logger: noopLogger,
      metrics: new ProcessorMetrics(),
      identity: IDENTITY,
    });
    await handle(payload("profile.created", { profile_id: "x" }));
    await handle(payload("profile.updated", { profile_id: "x" }));
    expect(writes).toHaveLength(0);
  });

  it("skips a malformed merge rather than retrying it forever", async () => {
    // No retry produces a different answer for a payload missing the fields
    // the map needs, and rethrowing would park it on the redelivery loop.
    const { store, writes } = fakeStore();
    const handle = createMergeHandler({
      store,
      logger: noopLogger,
      metrics: new ProcessorMetrics(),
      identity: IDENTITY,
    });
    await expect(
      handle(payload("identity.merged", { winner_profile_id: "only-one-side" })),
    ).resolves.toBeUndefined();
    expect(writes).toHaveLength(0);
  });

  it("rethrows a store failure, because the retry is free of consequence", async () => {
    // The upsert is idempotent — same event, same rows, collapsed by the
    // engine — so a ClickHouse blip is worth retrying rather than dropping.
    const store: MergeMapStore = {
      chainedInto: async () => [],
      upsert: async () => {
        throw new Error("clickhouse unreachable");
      },
    };
    const handle = createMergeHandler({
      store,
      logger: noopLogger,
      metrics: new ProcessorMetrics(),
      identity: IDENTITY,
    });
    await expect(handle(payload("identity.merged", MERGE_PROPS))).rejects.toThrow(
      /clickhouse unreachable/,
    );
  });

  it("collapses a chain end to end", async () => {
    const { store, writes } = fakeStore([
      { loser_profile_id: "0193a000-0000-7000-8000-00000000000a", merge_id: "m1", reason: "email" },
    ]);
    const handle = createMergeHandler({
      store,
      logger: noopLogger,
      metrics: new ProcessorMetrics(),
      identity: IDENTITY,
    });
    await handle(
      payload("identity.merged", {
        ...MERGE_PROPS,
        loser_profile_id: "0193b000-0000-7000-8000-00000000000b",
        winner_profile_id: "0193c000-0000-7000-8000-00000000000c",
      }),
    );
    const winners = new Set(writes[0]?.map((r) => r.winner_profile_id));
    expect(winners).toEqual(new Set(["0193c000-0000-7000-8000-00000000000c"]));
    expect(writes[0]).toHaveLength(2);
  });
});
