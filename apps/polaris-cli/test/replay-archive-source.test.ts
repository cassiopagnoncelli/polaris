/**
 * The archive is reached, not merely reachable.
 *
 * Two claims are tested separately because they fail separately:
 *
 *   1. the adapters do the right thing given a plan  (`archive-adapters`)
 *   2. the runner GIVES them the plan                (`buildReplayExecuteRunner`)
 *
 * The second is the one that has been shipped missing before — a
 * mechanism built, tested in isolation, and never connected to the thing
 * that would call it.
 */

import type { ReplayExecutorSource, ReplayPlan, ReplaySourceEvent } from "@polaris/shared-replay";
import { describe, expect, it } from "vitest";

import {
  buildArchiveReplaySource,
  buildMixedReplaySource,
} from "../src/commands/replay/archive-adapters.js";

function event(id: string, at: string): ReplaySourceEvent {
  return {
    event_id: id,
    event_name: "purchase",
    project_id: "storefront",
    environment: "production",
    occurred_at: at,
    partition_key: id,
    value: new TextEncoder().encode("{}"),
    headers: {},
  };
}

function fixedSource(events: readonly ReplaySourceEvent[]): ReplayExecutorSource & {
  readonly calls: number[];
} {
  const calls: number[] = [];
  return {
    calls,
    async fetchChunk() {
      calls.push(1);
      return events;
    },
  };
}

const PLAN = {
  project_id: "storefront",
  environment: "production",
  event_name: null,
  event_id: null,
} as unknown as ReplayPlan;

describe("buildArchiveReplaySource", () => {
  it("passes plan scope through and projects the archived events", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const source = buildArchiveReplaySource({
      archive: {
        async fetchChunk(input) {
          seen.push(input as unknown as Record<string, unknown>);
          return [event("a", "2024-06-01T10:00:00.000Z")];
        },
        async coveredDates() {
          return [];
        },
      },
    });

    const events = await source.fetchChunk({
      chunk: { from: "2024-06-01T00:00:00.000Z", to: "2024-06-02T00:00:00.000Z" } as never,
      plan: PLAN,
    });

    expect(events.map((e) => e.event_id)).toEqual(["a"]);
    expect(seen[0]?.["plan"]).toEqual({
      project_id: "storefront",
      environment: "production",
      event_name: null,
      event_id: null,
    });
  });
});

describe("buildMixedReplaySource", () => {
  const CUTOFF = new Date("2026-05-17T00:00:00.000Z");

  function mixed() {
    const archive = fixedSource([event("old", "2026-05-01T00:00:00.000Z")]);
    const stream = fixedSource([event("new", "2026-06-01T00:00:00.000Z")]);
    return {
      archive,
      stream,
      source: buildMixedReplaySource({ stream, archive, retentionCutoff: CUTOFF }),
    };
  }

  it("reads a wholly-archived chunk from the archive only", async () => {
    const { source, archive, stream } = mixed();

    await source.fetchChunk({
      chunk: { from: "2026-05-01T00:00:00.000Z", to: "2026-05-02T00:00:00.000Z" } as never,
      plan: PLAN,
    });

    expect(archive.calls).toHaveLength(1);
    expect(stream.calls).toHaveLength(0);
  });

  it("reads a wholly-retained chunk from the stream only", async () => {
    const { source, archive, stream } = mixed();

    await source.fetchChunk({
      chunk: { from: "2026-06-01T00:00:00.000Z", to: "2026-06-02T00:00:00.000Z" } as never,
      plan: PLAN,
    });

    expect(archive.calls).toHaveLength(0);
    expect(stream.calls).toHaveLength(1);
  });

  it("reads BOTH for a chunk straddling the boundary, and dedupes", async () => {
    // The retention edge moves while the replay runs, so which side owns
    // an event inside the straddling chunk has no stable answer. Reading
    // both is the only version that cannot drop an event at the seam.
    const shared = event("shared", "2026-05-17T01:00:00.000Z");
    const archive = fixedSource([shared, event("old", "2026-05-16T23:00:00.000Z")]);
    const stream = fixedSource([shared, event("new", "2026-05-17T02:00:00.000Z")]);
    const source = buildMixedReplaySource({ stream, archive, retentionCutoff: CUTOFF });

    const events = await source.fetchChunk({
      chunk: { from: "2026-05-16T12:00:00.000Z", to: "2026-05-17T12:00:00.000Z" } as never,
      plan: PLAN,
    });

    expect(archive.calls).toHaveLength(1);
    expect(stream.calls).toHaveLength(1);
    expect(events.map((e) => e.event_id)).toEqual(["shared", "old", "new"]);
  });

  it("refuses an unparseable chunk rather than guessing a side", async () => {
    const { source } = mixed();

    await expect(
      source.fetchChunk({ chunk: { from: "never", to: "later" } as never, plan: PLAN }),
    ).rejects.toThrow(/chunk timestamp parse failed/);
  });
});
