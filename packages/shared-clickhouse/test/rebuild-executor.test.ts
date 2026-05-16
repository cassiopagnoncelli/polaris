/**
 * Behavioural tests for the ClickHouse rebuild executor (GWNZH1N5).
 *
 * The executor is pure orchestration over an injected
 * {@link ClickhouseRebuildDriver} and {@link ClickhouseRebuildStore}.
 * These tests assert:
 *
 *   - happy path: pending → running → completed with rows summed,
 *   - mid-rebuild failure: driver throws → markFailed with the error
 *     pair, outcome surfaces `failed`,
 *   - clearSlice failure: driver throws before partition loop,
 *     outcome reports zero partitions processed,
 *   - peer-aborted: markRunning returns `aborted` → outcome reports
 *     `aborted`, driver never consulted,
 *   - row deleted between operations: markRunning returns null →
 *     `row_missing` refusal raised,
 *   - non-pending row at markRunning (e.g. `running` already) →
 *     `row_already_terminal` refusal raised,
 *   - projection not in the closed set → `projection_not_rebuildable`
 *     refusal raised without touching the store.
 *
 * @see packages/shared-clickhouse/src/rebuild/executor.ts
 */

import { describe, expect, it } from "vitest";

import {
  type ClickhouseRebuildDriver,
  ClickhouseRebuildExecutorError,
  type ClickhouseRebuildPlanned,
  type ClickhouseRebuildStore,
  executeClickhouseRebuild,
  findRebuildableProjection,
  REBUILD_EXECUTOR_VERSION,
} from "../src/rebuild/index.js";

const EVENT_DAILY_COUNTS_DESCRIPTOR = (() => {
  const d = findRebuildableProjection("event_daily_counts");
  if (d === null) throw new Error("test fixture requires event_daily_counts descriptor");
  return d;
})();

const PLAN: ClickhouseRebuildPlanned = {
  kind: "planned",
  projection: "event_daily_counts",
  descriptor: EVENT_DAILY_COUNTS_DESCRIPTOR,
  targetTableQualified: "polaris.event_daily_counts",
  sourceRangeFrom: null,
  sourceRangeTo: null,
  partitions: [
    { partition: "202604", rowsEstimated: 10_000 },
    { partition: "202605", rowsEstimated: 25_000 },
  ],
  partitionCount: 2,
  rowsTotalEstimated: 35_000,
  knownGaps: [],
  plannerVersion: "v1",
  plannedAt: "2026-05-15T12:00:00.000Z",
};

const T_RUN = new Date("2026-05-15T12:00:00.000Z");
const T_DONE = new Date("2026-05-15T12:05:00.000Z");

class RecordingStore {
  public events: Array<
    | { kind: "markRunning"; now: string }
    | { kind: "markCompleted"; now: string; rows_inserted: number }
    | { kind: "markFailed"; now: string; error_class: string; error_message: string }
  > = [];

  constructor(
    private readonly behavior: {
      markRunning?: () => Promise<
        { readonly status: "pending" | "running" | "aborted" | "completed" } | null
      >;
    } = {},
  ) {}

  asStore(): ClickhouseRebuildStore {
    const self = this;
    return {
      async markRunning(input) {
        self.events.push({ kind: "markRunning", now: input.now.toISOString() });
        if (self.behavior.markRunning !== undefined) {
          return self.behavior.markRunning();
        }
        return { status: "running" };
      },
      async markCompleted(input) {
        self.events.push({
          kind: "markCompleted",
          now: input.now.toISOString(),
          rows_inserted: input.rows_inserted,
        });
        return { status: "completed" };
      },
      async markFailed(input) {
        self.events.push({
          kind: "markFailed",
          now: input.now.toISOString(),
          error_class: input.error_class,
          error_message: input.error_message,
        });
        return { status: "failed" };
      },
    };
  }
}

interface DriverCall {
  readonly method: "clearSlice" | "rebuildPartition";
  readonly partition: string | null;
}

function happyDriver(rowsPerPartition = 50): {
  readonly driver: ClickhouseRebuildDriver;
  readonly calls: DriverCall[];
} {
  const calls: DriverCall[] = [];
  return {
    driver: {
      async clearSlice() {
        calls.push({ method: "clearSlice", partition: null });
      },
      async rebuildPartition(input) {
        calls.push({ method: "rebuildPartition", partition: input.partition });
        return { rows_inserted: rowsPerPartition };
      },
    },
    calls,
  };
}

function buildClock(values: Date[]): () => Date {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] as Date;
}

describe("executeClickhouseRebuild", () => {
  it("happy path: drives clearSlice + per-partition rebuild and marks completed", async () => {
    const store = new RecordingStore();
    const { driver, calls } = happyDriver(50);
    const outcome = await executeClickhouseRebuild({
      plan: PLAN,
      clickhouse_rebuild_job_id: "polaris_chr_happy",
      store: store.asStore(),
      driver,
      now: buildClock([T_RUN, T_DONE]),
    });
    expect(outcome.status).toBe("completed");
    expect(outcome.clickhouse_rebuild_job_id).toBe("polaris_chr_happy");
    expect(outcome.started_at).toBe(T_RUN.toISOString());
    expect(outcome.finished_at).toBe(T_DONE.toISOString());
    expect(outcome.partitions).toEqual([
      { partition: "202604", rows_inserted: 50 },
      { partition: "202605", rows_inserted: 50 },
    ]);
    expect(outcome.rows_inserted_total).toBe(100);
    expect(outcome.error).toBeNull();
    expect(outcome.executor_version).toBe(REBUILD_EXECUTOR_VERSION);
    // Driver call sequence: clearSlice first, then partitions in plan order.
    expect(calls.map((c) => c.method)).toEqual([
      "clearSlice",
      "rebuildPartition",
      "rebuildPartition",
    ]);
    // Store event ordering: markRunning → markCompleted.
    expect(store.events.map((e) => e.kind)).toEqual(["markRunning", "markCompleted"]);
    const completed = store.events[1];
    if (completed?.kind === "markCompleted") {
      expect(completed.rows_inserted).toBe(100);
    }
  });

  it("mid-rebuild failure: rebuildPartition throws → markFailed with error pair, outcome=failed", async () => {
    const store = new RecordingStore();
    const calls: DriverCall[] = [];
    const driver: ClickhouseRebuildDriver = {
      async clearSlice() {
        calls.push({ method: "clearSlice", partition: null });
      },
      async rebuildPartition(input) {
        calls.push({ method: "rebuildPartition", partition: input.partition });
        if (input.partition === "202605") {
          throw Object.assign(new Error("disk pressure"), { name: "ClickHouseDriverError" });
        }
        return { rows_inserted: 75 };
      },
    };
    const outcome = await executeClickhouseRebuild({
      plan: PLAN,
      clickhouse_rebuild_job_id: "polaris_chr_failed",
      store: store.asStore(),
      driver,
      now: buildClock([T_RUN, T_DONE]),
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toEqual({
      error_class: "ClickHouseDriverError",
      error_message: "disk pressure",
    });
    // First partition reported its rows; second partition failed.
    expect(outcome.partitions).toEqual([{ partition: "202604", rows_inserted: 75 }]);
    expect(outcome.rows_inserted_total).toBe(75);
    // Both partitions were attempted before short-circuit.
    expect(calls.map((c) => c.partition)).toEqual([null, "202604", "202605"]);
    // Store transitioned running → failed.
    expect(store.events.map((e) => e.kind)).toEqual(["markRunning", "markFailed"]);
    const failed = store.events[1];
    if (failed?.kind === "markFailed") {
      expect(failed.error_class).toBe("ClickHouseDriverError");
      expect(failed.error_message).toBe("disk pressure");
    }
  });

  it("clearSlice failure: no partitions get processed, outcome=failed", async () => {
    const store = new RecordingStore();
    const calls: DriverCall[] = [];
    const driver: ClickhouseRebuildDriver = {
      async clearSlice() {
        calls.push({ method: "clearSlice", partition: null });
        throw Object.assign(new Error("ALTER TABLE timed out"), {
          name: "ClickHouseMutationTimeout",
        });
      },
      async rebuildPartition(input) {
        calls.push({ method: "rebuildPartition", partition: input.partition });
        return { rows_inserted: 0 };
      },
    };
    const outcome = await executeClickhouseRebuild({
      plan: PLAN,
      clickhouse_rebuild_job_id: "polaris_chr_clearfail",
      store: store.asStore(),
      driver,
      now: buildClock([T_RUN, T_DONE]),
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.partitions).toEqual([]);
    expect(outcome.rows_inserted_total).toBe(0);
    expect(outcome.error?.error_class).toBe("ClickHouseMutationTimeout");
    // Partition rebuild was never attempted.
    expect(calls.map((c) => c.method)).toEqual(["clearSlice"]);
  });

  it("peer-aborted: markRunning returns aborted → outcome=aborted, driver untouched", async () => {
    const store = new RecordingStore({
      markRunning: async () => ({ status: "aborted" }),
    });
    const { driver, calls } = happyDriver();
    const outcome = await executeClickhouseRebuild({
      plan: PLAN,
      clickhouse_rebuild_job_id: "polaris_chr_aborted",
      store: store.asStore(),
      driver,
      now: buildClock([T_RUN, T_DONE]),
    });
    expect(outcome.status).toBe("aborted");
    expect(outcome.partitions).toEqual([]);
    expect(outcome.rows_inserted_total).toBe(0);
    expect(outcome.error).toBeNull();
    // Driver never reached.
    expect(calls).toHaveLength(0);
    // Only one store event — the markRunning attempt.
    expect(store.events.map((e) => e.kind)).toEqual(["markRunning"]);
  });

  it("row missing at markRunning: raises row_missing refusal", async () => {
    const store = new RecordingStore({
      markRunning: async () => null,
    });
    const { driver, calls } = happyDriver();
    await expect(
      executeClickhouseRebuild({
        plan: PLAN,
        clickhouse_rebuild_job_id: "polaris_chr_missing",
        store: store.asStore(),
        driver,
        now: buildClock([T_RUN]),
      }),
    ).rejects.toMatchObject({
      name: "ClickhouseRebuildExecutorError",
      code: "row_missing",
    });
    expect(calls).toHaveLength(0);
  });

  it("non-pending row at markRunning: raises row_already_terminal refusal", async () => {
    const store = new RecordingStore({
      markRunning: async () => ({ status: "completed" }),
    });
    const { driver, calls } = happyDriver();
    await expect(
      executeClickhouseRebuild({
        plan: PLAN,
        clickhouse_rebuild_job_id: "polaris_chr_already",
        store: store.asStore(),
        driver,
        now: buildClock([T_RUN]),
      }),
    ).rejects.toMatchObject({
      name: "ClickhouseRebuildExecutorError",
      code: "row_already_terminal",
    });
    expect(calls).toHaveLength(0);
  });

  it("projection not in closed set: raises projection_not_rebuildable BEFORE touching the store", async () => {
    const badPlan: ClickhouseRebuildPlanned = {
      ...PLAN,
      projection: "bogus_projection",
      targetTableQualified: "polaris.bogus_projection",
    };
    const store = new RecordingStore();
    const { driver, calls } = happyDriver();
    let thrown: unknown = null;
    try {
      await executeClickhouseRebuild({
        plan: badPlan,
        clickhouse_rebuild_job_id: "polaris_chr_bogus",
        store: store.asStore(),
        driver,
        now: buildClock([T_RUN]),
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ClickhouseRebuildExecutorError);
    if (thrown instanceof ClickhouseRebuildExecutorError) {
      expect(thrown.code).toBe("projection_not_rebuildable");
    }
    // Neither the store nor the driver were touched.
    expect(store.events).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("default clock: now defaults to system clock when not supplied", async () => {
    const store = new RecordingStore();
    const { driver } = happyDriver(10);
    const before = Date.now();
    const outcome = await executeClickhouseRebuild({
      plan: PLAN,
      clickhouse_rebuild_job_id: "polaris_chr_clock",
      store: store.asStore(),
      driver,
    });
    const after = Date.now();
    expect(outcome.status).toBe("completed");
    const startedMs = Date.parse(outcome.started_at);
    expect(startedMs).toBeGreaterThanOrEqual(before);
    expect(startedMs).toBeLessThanOrEqual(after);
  });

  it("error_class truncation: name longer than 128 chars is clipped on the outcome and the store call", async () => {
    const store = new RecordingStore();
    const longName = `Err${"x".repeat(200)}`;
    const driver: ClickhouseRebuildDriver = {
      async clearSlice() {
        throw Object.assign(new Error("boom"), { name: longName });
      },
      async rebuildPartition() {
        return { rows_inserted: 0 };
      },
    };
    const outcome = await executeClickhouseRebuild({
      plan: PLAN,
      clickhouse_rebuild_job_id: "polaris_chr_longerr",
      store: store.asStore(),
      driver,
      now: buildClock([T_RUN, T_DONE]),
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.error_class.length).toBe(128);
    const failedEvent = store.events.find((e) => e.kind === "markFailed");
    if (failedEvent?.kind === "markFailed") {
      expect(failedEvent.error_class.length).toBe(128);
    }
  });
});
