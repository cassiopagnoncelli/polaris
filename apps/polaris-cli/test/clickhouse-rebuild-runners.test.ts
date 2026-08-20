/**
 * Behavioural tests for the `polaris clickhouse-rebuild` runners
 * (P7-005).
 *
 * Mirror of `replay-plan-runner.test.ts` + `replay-runner-behaviors.test.ts`
 * for the new command group. Each test injects an in-memory store +
 * deterministic id/clock hooks + stubbed `readPartitions` adapter and
 * asserts on the state the store observes.
 *
 * Coverage matrix:
 *
 *   plan        happy path → planned plan rendered as human + json
 *               rejection codes → UsageError with structured message
 *               readPartitions adapter is consulted
 *               --from/--to pairing rule
 *
 *   create      --dry-run        → persists `dry_run` row + audit, exits 0
 *               (no --dry-run)   → persists `pending` row + audit, then drives
 *                                  the rebuild executor through pending →
 *                                  running → completed / failed and stamps the
 *                                  row.
 *               unknown projection → UsageError BEFORE any DB call
 *               planner rejection  → UsageError before any DB call
 *
 *   list        filter passthrough
 *   show        happy path + missing id
 *   abort       happy path + already-terminal idempotent + missing id
 *
 * @see docs/implementation/tasks/P7-005-clickhouse-rebuild-workflows.md
 */

import type {
  ClickhouseRebuildDriver,
  ClickhouseRebuildOutcomeStatus,
  ClickhouseRebuildStore,
  ClickhouseRebuildStoreStatus,
  PartsSummary,
} from "@polaris/persistence-clickhouse/rebuild";
import { describe, expect, it } from "vitest";

import {
  buildClickhouseRebuildAbortRunner,
  buildClickhouseRebuildCreateRunner,
  buildClickhouseRebuildListRunner,
  buildClickhouseRebuildPlanRunner,
  buildClickhouseRebuildShowRunner,
  type ClickhouseRebuildAbortStore,
  type ClickhouseRebuildCreateAuditPayload,
  type ClickhouseRebuildCreateStore,
  type ClickhouseRebuildDriverHandle,
  type ClickhouseRebuildExecutorStoreHandle,
  type ClickhouseRebuildJobRow,
  type ClickhouseRebuildListStore,
  type ClickhouseRebuildShowStore,
  CliError,
  type CommandContext,
  type InsertClickhouseRebuildJobInput,
  type ListClickhouseRebuildJobsFilter,
  type OutputStreams,
  type PackageMeta,
  UsageError,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const META: PackageMeta = {
  version: "0.0.0-test",
  gitSha: "deadbeef",
  buildTime: "2026-05-15T00:00:00.000Z",
  nodeVersion: "v22.0.0",
};

const NOW = new Date("2026-05-15T12:00:00.000Z");

interface Capture {
  readonly streams: OutputStreams;
  readonly stdout: string[];
  readonly stderr: string[];
}

function captureOutput(): Capture {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    streams: {
      writeOut: (text) => {
        stdout.push(text);
      },
      writeErr: (text) => {
        stderr.push(text);
      },
    },
    stdout,
    stderr,
  };
}

function makeContext(streams: OutputStreams, format: "human" | "json" = "human"): CommandContext {
  const noopLogger = {
    fatal: () => {},
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
  } as unknown as CommandContext["logger"];
  return {
    config: {
      profile: "default",
      apiUrl: "https://polaris.example.internal",
      token: "polaris_ot_test",
      tokenEnvName: "POLARIS_TOKEN",
      output: format,
      logLevel: "warn",
      configFilePath: undefined,
    },
    logger: {
      ...noopLogger,
      child: () => noopLogger,
    } as CommandContext["logger"],
    output: streams,
    meta: META,
    actor: { source: "cli", label: "cli" },
  };
}

function stubAdapter(
  summary: PartsSummary | Error,
): (input: {
  qualifiedTable: string;
  fromTs: Date | null;
  toTs: Date | null;
}) => Promise<PartsSummary> {
  return async () => {
    if (summary instanceof Error) throw summary;
    return summary;
  };
}

const SEED_ROW: ClickhouseRebuildJobRow = {
  clickhouse_rebuild_job_id: "polaris_chr_seed",
  target_projection: "event_daily_counts",
  target_table_qualified: "polaris.event_daily_counts",
  source_range_from: null,
  source_range_to: null,
  reason: "seed for tests",
  requester_actor_label: "cli",
  status: "dry_run",
  rows_estimated: 35_000,
  partitions_estimated: 2,
  error_class: null,
  error_message: null,
  created_at: "2026-05-15T12:00:00.000Z",
  updated_at: "2026-05-15T12:00:00.000Z",
  started_at: null,
  completed_at: null,
};

function seedRow(overrides: Partial<ClickhouseRebuildJobRow> = {}): ClickhouseRebuildJobRow {
  return { ...SEED_ROW, ...overrides };
}

class InMemoryStore {
  public rows = new Map<string, ClickhouseRebuildJobRow>();
  public inserts: InsertClickhouseRebuildJobInput[] = [];
  public audits: ClickhouseRebuildCreateAuditPayload[] = [];
  public abortAudits: Array<{
    readonly id: string;
    readonly reason: string;
    readonly before: ClickhouseRebuildJobRow;
  }> = [];
  public closeCalls = 0;

  seed(row: ClickhouseRebuildJobRow): void {
    this.rows.set(row.clickhouse_rebuild_job_id, row);
  }

  asCreateStore(): ClickhouseRebuildCreateStore {
    return {
      insertWithAudit: async (input, audit) => {
        this.inserts.push(input);
        this.audits.push(audit);
        const row: ClickhouseRebuildJobRow = {
          clickhouse_rebuild_job_id: input.clickhouse_rebuild_job_id,
          target_projection: input.target_projection,
          target_table_qualified: input.target_table_qualified,
          source_range_from: input.source_range_from?.toISOString() ?? null,
          source_range_to: input.source_range_to?.toISOString() ?? null,
          reason: input.reason,
          requester_actor_label: input.requester_actor_label,
          status: input.status ?? "pending",
          rows_estimated: input.rows_estimated ?? null,
          partitions_estimated: input.partitions_estimated ?? null,
          error_class: null,
          error_message: null,
          created_at: NOW.toISOString(),
          updated_at: NOW.toISOString(),
          started_at: null,
          completed_at: null,
        };
        this.rows.set(row.clickhouse_rebuild_job_id, row);
      },
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }

  asListStore(): ClickhouseRebuildListStore {
    return {
      list: async (filter: ListClickhouseRebuildJobsFilter) => {
        const rows = [...this.rows.values()].filter((row) => {
          if (filter.status !== undefined && row.status !== filter.status) return false;
          if (filter.projection !== undefined && row.target_projection !== filter.projection)
            return false;
          return true;
        });
        return filter.limit !== undefined ? rows.slice(0, filter.limit) : rows;
      },
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }

  asShowStore(): ClickhouseRebuildShowStore {
    return {
      findById: async (id) => this.rows.get(id) ?? null,
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }

  asAbortStore(): ClickhouseRebuildAbortStore {
    return {
      findById: async (id) => this.rows.get(id) ?? null,
      abortWithAudit: async (input) => {
        const row = this.rows.get(input.jobId);
        if (row === undefined) return { kind: "not_found" as const };
        if (row.status === "completed" || row.status === "failed" || row.status === "aborted") {
          return { kind: "already_terminal" as const, row };
        }
        const updated: ClickhouseRebuildJobRow = {
          ...row,
          status: "aborted",
          completed_at: input.abortedAt.toISOString(),
          updated_at: input.abortedAt.toISOString(),
        };
        this.rows.set(input.jobId, updated);
        this.abortAudits.push({
          id: input.auditId,
          reason: input.reason,
          before: input.before,
        });
        return { kind: "aborted" as const, row: updated };
      },
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }

  /**
   * Lifecycle store the create-runner hands the executor on the
   * non-dry-run path. Returns a fresh handle on every `openExecutorStore`
   * call so `closeCalls` reflects real lifecycle.
   */
  asExecutorStore(): ClickhouseRebuildExecutorStoreHandle {
    const store: ClickhouseRebuildStore = {
      markRunning: async (input) => {
        const row = this.rows.get(input.clickhouse_rebuild_job_id);
        if (row === undefined) return null;
        // Mirror the SQL guard: status must be `pending` to transition.
        // Anything else surfaces as-is so the executor can branch on it.
        if (row.status !== "pending") {
          return { status: row.status as ClickhouseRebuildStoreStatus["status"] };
        }
        const updated: ClickhouseRebuildJobRow = {
          ...row,
          status: "running",
          started_at: input.now.toISOString(),
          updated_at: input.now.toISOString(),
        };
        this.rows.set(updated.clickhouse_rebuild_job_id, updated);
        return { status: "running" };
      },
      markCompleted: async (input) => {
        const row = this.rows.get(input.clickhouse_rebuild_job_id);
        if (row === undefined) return null;
        if (row.status !== "running") {
          return { status: row.status as ClickhouseRebuildStoreStatus["status"] };
        }
        const updated: ClickhouseRebuildJobRow = {
          ...row,
          status: "completed",
          completed_at: input.now.toISOString(),
          updated_at: input.now.toISOString(),
        };
        this.rows.set(updated.clickhouse_rebuild_job_id, updated);
        return { status: "completed" };
      },
      markFailed: async (input) => {
        const row = this.rows.get(input.clickhouse_rebuild_job_id);
        if (row === undefined) return null;
        if (row.status !== "running") {
          return { status: row.status as ClickhouseRebuildStoreStatus["status"] };
        }
        // Enforce the same schema CHECKs we ship in the migration:
        //   - error_class / error_message both NOT NULL when status = failed
        //   - error_class length in [1, 64]
        //   - error_message length in [1, 4096]
        if (
          input.error_class.length === 0 ||
          input.error_class.length > 64 ||
          input.error_message.length === 0 ||
          input.error_message.length > 4096
        ) {
          throw new Error(
            `clickhouse_rebuild_jobs error_pair_length CHECK violated: class=${input.error_class.length} message=${input.error_message.length}`,
          );
        }
        const updated: ClickhouseRebuildJobRow = {
          ...row,
          status: "failed",
          error_class: input.error_class,
          error_message: input.error_message,
          completed_at: input.now.toISOString(),
          updated_at: input.now.toISOString(),
        };
        this.rows.set(updated.clickhouse_rebuild_job_id, updated);
        return { status: "failed" };
      },
    };
    return {
      store,
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }
}

interface DriverCall {
  readonly method: "clearSlice" | "rebuildPartition";
  readonly partition: string | null;
}

interface SyntheticDriverOptions {
  readonly throwOnClearSlice?: Error;
  readonly throwOnPartition?: { readonly partition: string; readonly err: Error };
  readonly rowsPerPartition?: number;
}

function syntheticDriver(opts: SyntheticDriverOptions = {}): {
  readonly driver: ClickhouseRebuildDriver;
  readonly calls: DriverCall[];
} {
  const calls: DriverCall[] = [];
  const driver: ClickhouseRebuildDriver = {
    async clearSlice() {
      calls.push({ method: "clearSlice", partition: null });
      if (opts.throwOnClearSlice !== undefined) throw opts.throwOnClearSlice;
    },
    async rebuildPartition(input) {
      calls.push({ method: "rebuildPartition", partition: input.partition });
      if (
        opts.throwOnPartition !== undefined &&
        opts.throwOnPartition.partition === input.partition
      ) {
        throw opts.throwOnPartition.err;
      }
      return { rows_inserted: opts.rowsPerPartition ?? 100 };
    },
  };
  return { driver, calls };
}

function driverHandle(driver: ClickhouseRebuildDriver): ClickhouseRebuildDriverHandle {
  return {
    driver,
    close: async () => undefined,
  };
}

const HAPPY_PARTS: PartsSummary = {
  partitions: [
    { partition: "202604", rowsEstimated: 10_000 },
    { partition: "202605", rowsEstimated: 25_000 },
  ],
};

// ---------------------------------------------------------------------------
// plan runner
// ---------------------------------------------------------------------------

describe("clickhouse-rebuild plan runner", () => {
  it("happy path: renders the plan as human text", async () => {
    const cap = captureOutput();
    const ctx = makeContext(cap.streams, "human");
    const runner = buildClickhouseRebuildPlanRunner({
      now: () => NOW,
      readPartitions: stubAdapter(HAPPY_PARTS),
    });
    await runner({ projection: "event_daily_counts" }, ctx);
    const out = cap.stdout.join("");
    expect(out).toContain("polaris clickhouse-rebuild plan (dry-run; planner v1)");
    expect(out).toContain("projection             event_daily_counts");
    expect(out).toContain("target_table           polaris.event_daily_counts");
    expect(out).toContain("partitions             2");
    expect(out).toContain("rows_total_estimated   35000");
  });

  it("--output json renders the planned plan structure", async () => {
    const cap = captureOutput();
    const ctx = makeContext(cap.streams, "json");
    const runner = buildClickhouseRebuildPlanRunner({
      now: () => NOW,
      readPartitions: stubAdapter(HAPPY_PARTS),
    });
    await runner({ projection: "event_daily_counts" }, ctx);
    const parsed = JSON.parse(cap.stdout.join(""));
    expect(parsed).toMatchObject({
      kind: "planned",
      projection: "event_daily_counts",
      targetTableQualified: "polaris.event_daily_counts",
      partitionCount: 2,
      rowsTotalEstimated: 35_000,
      plannerVersion: "v1",
    });
  });

  it("rejects unknown projection with a usage error carrying the planner code", async () => {
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const runner = buildClickhouseRebuildPlanRunner({
      now: () => NOW,
      readPartitions: stubAdapter(HAPPY_PARTS),
    });
    await expect(runner({ projection: "bogus" }, ctx)).rejects.toMatchObject({
      message: expect.stringContaining("clickhouse_rebuild_rejected:unknown_projection"),
    });
  });

  it("rejects --from supplied without --to", async () => {
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const runner = buildClickhouseRebuildPlanRunner({
      now: () => NOW,
      readPartitions: stubAdapter(HAPPY_PARTS),
    });
    await expect(
      runner({ projection: "event_daily_counts", from: "2026-05-01T00:00:00Z" }, ctx),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it("rejects when projection is missing", async () => {
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const runner = buildClickhouseRebuildPlanRunner({
      now: () => NOW,
      readPartitions: stubAdapter(HAPPY_PARTS),
    });
    await expect(runner({}, ctx)).rejects.toBeInstanceOf(UsageError);
  });

  it("rejects when projection is empty after trim", async () => {
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const runner = buildClickhouseRebuildPlanRunner({
      now: () => NOW,
      readPartitions: stubAdapter(HAPPY_PARTS),
    });
    await expect(runner({ projection: "   " }, ctx)).rejects.toBeInstanceOf(UsageError);
  });

  it("surfaces clickhouse_unreachable when the wired adapter throws", async () => {
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const runner = buildClickhouseRebuildPlanRunner({
      now: () => NOW,
      readPartitions: stubAdapter(new Error("system.parts query failed: connection refused")),
    });
    await expect(runner({ projection: "event_daily_counts" }, ctx)).rejects.toMatchObject({
      message: expect.stringContaining("clickhouse_rebuild_rejected:clickhouse_unreachable"),
    });
  });
});

// ---------------------------------------------------------------------------
// create runner
// ---------------------------------------------------------------------------

describe("clickhouse-rebuild create runner", () => {
  it("--dry-run: persists a dry_run row + audit + exits without throwing", async () => {
    const store = new InMemoryStore();
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const runner = buildClickhouseRebuildCreateRunner({
      issueId: () => "polaris_chr_test1",
      openStore: () => store.asCreateStore(),
      now: () => NOW,
      generateAuditId: () => "polaris_aud_test1",
      readPartitions: stubAdapter(HAPPY_PARTS),
    });
    await runner(
      {
        projection: "event_daily_counts",
        dryRun: true,
        reason: "auditing rebuild flow",
      },
      ctx,
    );
    expect(store.inserts).toHaveLength(1);
    const insert = store.inserts[0];
    expect(insert?.clickhouse_rebuild_job_id).toBe("polaris_chr_test1");
    expect(insert?.target_projection).toBe("event_daily_counts");
    expect(insert?.target_table_qualified).toBe("polaris.event_daily_counts");
    expect(insert?.status).toBe("dry_run");
    expect(insert?.rows_estimated).toBe(35_000);
    expect(insert?.partitions_estimated).toBe(2);
    expect(store.audits).toHaveLength(1);
    const audit = store.audits[0];
    expect(audit?.after.status).toBe("dry_run");
    expect(audit?.reason).toBe("auditing rebuild flow");
    expect(store.closeCalls).toBe(1);
  });

  it("(no --dry-run, happy path): persists pending → executor drives running → completed", async () => {
    const store = new InMemoryStore();
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const { driver, calls } = syntheticDriver({ rowsPerPartition: 50 });
    const runner = buildClickhouseRebuildCreateRunner({
      issueId: () => "polaris_chr_pending1",
      openStore: () => store.asCreateStore(),
      openExecutorStore: () => store.asExecutorStore(),
      openDriver: async () => driverHandle(driver),
      now: () => NOW,
      generateAuditId: () => "polaris_aud_pending1",
      readPartitions: stubAdapter(HAPPY_PARTS),
    });
    await runner(
      {
        projection: "event_daily_counts",
        dryRun: false,
        reason: "real rebuild",
      },
      ctx,
    );
    expect(store.inserts).toHaveLength(1);
    expect(store.inserts[0]?.status).toBe("pending");
    // Driver was invoked once for clearSlice + once per planned partition.
    expect(calls.map((c) => c.method)).toEqual([
      "clearSlice",
      "rebuildPartition",
      "rebuildPartition",
    ]);
    expect(calls.filter((c) => c.method === "rebuildPartition").map((c) => c.partition)).toEqual([
      "202604",
      "202605",
    ]);
    // Row was stamped completed by the executor's markCompleted call.
    const row = store.rows.get("polaris_chr_pending1");
    expect(row?.status).toBe("completed");
    expect(row?.error_class).toBeNull();
    expect(row?.error_message).toBeNull();
  });

  it("(no --dry-run, mid-rebuild failure): driver throws on partition → row stamped failed with error pair", async () => {
    const store = new InMemoryStore();
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const { driver, calls } = syntheticDriver({
      throwOnPartition: {
        partition: "202605",
        err: Object.assign(new Error("INSERT failed because of disk pressure"), {
          name: "ClickHouseDriverError",
        }),
      },
    });
    const runner = buildClickhouseRebuildCreateRunner({
      issueId: () => "polaris_chr_failed1",
      openStore: () => store.asCreateStore(),
      openExecutorStore: () => store.asExecutorStore(),
      openDriver: async () => driverHandle(driver),
      now: () => NOW,
      generateAuditId: () => "polaris_aud_failed1",
      readPartitions: stubAdapter(HAPPY_PARTS),
    });
    let thrown: unknown = null;
    try {
      await runner(
        {
          projection: "event_daily_counts",
          dryRun: false,
          reason: "rebuild fails mid-flight",
        },
        ctx,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliError);
    if (thrown instanceof CliError) {
      expect(thrown.exitCode).toBe(1);
      expect(thrown.message).toContain("clickhouse_rebuild_failed");
      expect((thrown.details as Record<string, unknown>)["status"]).toBe("failed");
      expect((thrown.details as Record<string, unknown>)["error_class"]).toBe(
        "ClickHouseDriverError",
      );
    }
    // The first partition ran, then the second threw and short-circuited.
    expect(calls.map((c) => c.partition)).toEqual([null, "202604", "202605"]);
    // Row carries both error_class AND error_message (schema's error_pair_present CHECK).
    const row = store.rows.get("polaris_chr_failed1");
    expect(row?.status).toBe("failed");
    expect(row?.error_class).toBe("ClickHouseDriverError");
    expect(row?.error_message).toBe("INSERT failed because of disk pressure");
  });

  it("(no --dry-run, peer-aborted): markRunning returns aborted → executor short-circuits, throws CliError", async () => {
    const store = new InMemoryStore();
    // Pre-stamp the row as aborted BEFORE the create call by injecting a
    // store whose `markRunning` reports `aborted`. Simulates the case
    // where a sibling operator runs `polaris clickhouse-rebuild abort`
    // between the row insertion and the executor's first transition.
    const executorStore: ClickhouseRebuildStore = {
      markRunning: async () => ({ status: "aborted" }),
      markCompleted: async () => null,
      markFailed: async () => null,
    };
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const { driver, calls } = syntheticDriver();
    const runner = buildClickhouseRebuildCreateRunner({
      issueId: () => "polaris_chr_aborted1",
      openStore: () => store.asCreateStore(),
      openExecutorStore: () => ({ store: executorStore, close: async () => undefined }),
      openDriver: async () => driverHandle(driver),
      now: () => NOW,
      generateAuditId: () => "polaris_aud_aborted1",
      readPartitions: stubAdapter(HAPPY_PARTS),
    });
    let thrown: unknown = null;
    try {
      await runner(
        {
          projection: "event_daily_counts",
          dryRun: false,
          reason: "peer-aborted",
        },
        ctx,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliError);
    if (thrown instanceof CliError) {
      expect(thrown.exitCode).toBe(1);
      expect(thrown.message).toContain("clickhouse_rebuild_aborted");
      expect((thrown.details as Record<string, unknown>)["status"]).toBe("aborted");
    }
    // Driver was never consulted because the row was aborted before
    // we could enter the clearSlice phase.
    expect(calls).toHaveLength(0);
  });

  it("(no --dry-run): outcome JSON shape includes status + partitions + rows_inserted_total", async () => {
    const store = new InMemoryStore();
    const cap = captureOutput();
    const ctx = makeContext(cap.streams, "json");
    const { driver } = syntheticDriver({ rowsPerPartition: 25 });
    const runner = buildClickhouseRebuildCreateRunner({
      issueId: () => "polaris_chr_json1",
      openStore: () => store.asCreateStore(),
      openExecutorStore: () => store.asExecutorStore(),
      openDriver: async () => driverHandle(driver),
      now: () => NOW,
      generateAuditId: () => "polaris_aud_json1",
      readPartitions: stubAdapter(HAPPY_PARTS),
    });
    await runner(
      {
        projection: "event_daily_counts",
        dryRun: false,
        reason: "verify json shape",
      },
      ctx,
    );
    // The runner writes both the create-row payload and the outcome
    // payload to stdout; the outcome is the second write.
    expect(cap.stdout.length).toBeGreaterThanOrEqual(2);
    const outcome = JSON.parse(cap.stdout[cap.stdout.length - 1] as string);
    expect(outcome.status).toBe("completed" satisfies ClickhouseRebuildOutcomeStatus);
    expect(outcome.partitions).toHaveLength(2);
    expect(outcome.rows_inserted_total).toBe(50);
    expect(outcome.error).toBeNull();
    expect(outcome.executor_version).toBe("v1");
  });

  it("rejects unknown projection BEFORE any DB call", async () => {
    const store = new InMemoryStore();
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const runner = buildClickhouseRebuildCreateRunner({
      openStore: () => store.asCreateStore(),
      now: () => NOW,
      readPartitions: stubAdapter(HAPPY_PARTS),
    });
    await expect(
      runner({ projection: "bogus", dryRun: true, reason: "x" }, ctx),
    ).rejects.toBeInstanceOf(UsageError);
    expect(store.inserts).toHaveLength(0);
    expect(store.audits).toHaveLength(0);
  });

  it("rejects malformed --from/--to range BEFORE any DB call", async () => {
    const store = new InMemoryStore();
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const runner = buildClickhouseRebuildCreateRunner({
      openStore: () => store.asCreateStore(),
      now: () => NOW,
      readPartitions: stubAdapter(HAPPY_PARTS),
    });
    await expect(
      runner(
        {
          projection: "event_daily_counts",
          from: "2026-05-10T00:00:00Z",
          // missing --to
          dryRun: true,
          reason: "should fail",
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(UsageError);
    expect(store.inserts).toHaveLength(0);
  });

  it("propagates planner clickhouse_unreachable without writing a row", async () => {
    const store = new InMemoryStore();
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    // Adapter throws → planner returns clickhouse_unreachable.
    const runner = buildClickhouseRebuildCreateRunner({
      openStore: () => store.asCreateStore(),
      now: () => NOW,
      readPartitions: stubAdapter(new Error("system.parts query failed: connection refused")),
    });
    await expect(
      runner({ projection: "event_daily_counts", dryRun: true, reason: "x" }, ctx),
    ).rejects.toMatchObject({
      message: expect.stringContaining("clickhouse_rebuild_rejected:clickhouse_unreachable"),
    });
    expect(store.inserts).toHaveLength(0);
    expect(store.audits).toHaveLength(0);
  });

  it("rejects bounded range where from === to (range_empty)", async () => {
    const store = new InMemoryStore();
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const runner = buildClickhouseRebuildCreateRunner({
      openStore: () => store.asCreateStore(),
      now: () => NOW,
      readPartitions: stubAdapter(HAPPY_PARTS),
    });
    await expect(
      runner(
        {
          projection: "event_daily_counts",
          from: "2026-05-10T00:00:00Z",
          to: "2026-05-10T00:00:00Z",
          dryRun: true,
          reason: "should fail",
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(UsageError);
    expect(store.inserts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// list / show / abort
// ---------------------------------------------------------------------------

describe("clickhouse-rebuild list runner", () => {
  it("passes filter through to the store", async () => {
    const store = new InMemoryStore();
    store.seed(seedRow({ clickhouse_rebuild_job_id: "polaris_chr_a", status: "dry_run" }));
    store.seed(
      seedRow({
        clickhouse_rebuild_job_id: "polaris_chr_b",
        status: "pending",
        target_projection: "event_daily_counts",
      }),
    );
    const cap = captureOutput();
    const ctx = makeContext(cap.streams, "json");
    const runner = buildClickhouseRebuildListRunner({ openStore: () => store.asListStore() });
    await runner({ status: "dry_run" }, ctx);
    const parsed = JSON.parse(cap.stdout.join(""));
    expect(parsed.count).toBe(1);
    expect(parsed.rows[0].clickhouse_rebuild_job_id).toBe("polaris_chr_a");
  });

  it("rejects unknown status", async () => {
    const store = new InMemoryStore();
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const runner = buildClickhouseRebuildListRunner({ openStore: () => store.asListStore() });
    await expect(runner({ status: "bogus" }, ctx)).rejects.toBeInstanceOf(UsageError);
  });

  it("rejects --limit outside 1..500", async () => {
    const store = new InMemoryStore();
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const runner = buildClickhouseRebuildListRunner({ openStore: () => store.asListStore() });
    await expect(runner({ limit: "0" }, ctx)).rejects.toBeInstanceOf(UsageError);
    await expect(runner({ limit: "501" }, ctx)).rejects.toBeInstanceOf(UsageError);
  });

  it("empty result renders 'no clickhouse-rebuild jobs' line", async () => {
    const store = new InMemoryStore();
    const cap = captureOutput();
    const ctx = makeContext(cap.streams, "human");
    const runner = buildClickhouseRebuildListRunner({ openStore: () => store.asListStore() });
    await runner({}, ctx);
    expect(cap.stdout.join("")).toContain("no clickhouse-rebuild jobs");
  });
});

describe("clickhouse-rebuild show runner", () => {
  it("happy path: prints the row as human text", async () => {
    const store = new InMemoryStore();
    store.seed(seedRow());
    const cap = captureOutput();
    const ctx = makeContext(cap.streams, "human");
    const runner = buildClickhouseRebuildShowRunner({ openStore: () => store.asShowStore() });
    await runner({ id: "polaris_chr_seed" }, ctx);
    const out = cap.stdout.join("");
    expect(out).toContain("polaris clickhouse-rebuild job");
    expect(out).toContain("clickhouse_rebuild_job_id  polaris_chr_seed");
    expect(out).toContain("target_projection          event_daily_counts");
  });

  it("missing id throws UsageError", async () => {
    const store = new InMemoryStore();
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const runner = buildClickhouseRebuildShowRunner({ openStore: () => store.asShowStore() });
    await expect(runner({ id: "polaris_chr_missing" }, ctx)).rejects.toBeInstanceOf(UsageError);
  });

  it("empty id throws UsageError", async () => {
    const store = new InMemoryStore();
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const runner = buildClickhouseRebuildShowRunner({ openStore: () => store.asShowStore() });
    await expect(runner({ id: "   " }, ctx)).rejects.toBeInstanceOf(UsageError);
  });
});

describe("clickhouse-rebuild abort runner", () => {
  it("happy path: aborts an abortable row", async () => {
    const store = new InMemoryStore();
    store.seed(seedRow({ status: "pending" }));
    const cap = captureOutput();
    const ctx = makeContext(cap.streams, "human");
    const runner = buildClickhouseRebuildAbortRunner({
      openStore: () => store.asAbortStore(),
      now: () => NOW,
      generateAuditId: () => "polaris_aud_abort1",
    });
    await runner({ id: "polaris_chr_seed", reason: "rolled back manually" }, ctx);
    expect(store.abortAudits).toHaveLength(1);
    expect(store.abortAudits[0]?.reason).toBe("rolled back manually");
    const out = cap.stdout.join("");
    expect(out).toContain("aborted clickhouse rebuild job polaris_chr_seed");
  });

  it("already-terminal row: idempotent (no audit row, no throw)", async () => {
    const store = new InMemoryStore();
    store.seed(seedRow({ status: "completed" }));
    const cap = captureOutput();
    const ctx = makeContext(cap.streams, "human");
    const runner = buildClickhouseRebuildAbortRunner({
      openStore: () => store.asAbortStore(),
      now: () => NOW,
    });
    await runner({ id: "polaris_chr_seed", reason: "no-op" }, ctx);
    expect(store.abortAudits).toHaveLength(0);
    expect(cap.stdout.join("")).toContain("already completed");
  });

  it("missing id throws UsageError", async () => {
    const store = new InMemoryStore();
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const runner = buildClickhouseRebuildAbortRunner({
      openStore: () => store.asAbortStore(),
      now: () => NOW,
    });
    await expect(runner({ id: "polaris_chr_missing", reason: "x" }, ctx)).rejects.toBeInstanceOf(
      UsageError,
    );
  });

  it("missing --reason throws UsageError", async () => {
    const store = new InMemoryStore();
    store.seed(seedRow({ status: "pending" }));
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const runner = buildClickhouseRebuildAbortRunner({
      openStore: () => store.asAbortStore(),
      now: () => NOW,
    });
    await expect(runner({ id: "polaris_chr_seed" }, ctx)).rejects.toBeInstanceOf(UsageError);
    await expect(runner({ id: "polaris_chr_seed", reason: "   " }, ctx)).rejects.toBeInstanceOf(
      UsageError,
    );
  });
});
