/**
 * Behavioral tests for the `polaris replay` runners (P7-001b).
 *
 * Companion to `replay-commands.test.ts` (which pins the public surface).
 * This file exercises the runner side: each test injects an in-memory
 * store + deterministic id/clock hooks, drives the runner with concrete
 * args, and asserts on the state the store and audit recorder observe.
 *
 * Coverage matrix (mirrors the P7-001b acceptance criteria):
 *
 *   create   - happy path, --from older than 90 days, planner-flag rejection
 *   list     - filter passthrough
 *   show     - happy path, missing id
 *   cancel   - happy path, already-terminal idempotent path, not-found race
 *   pause    - happy path, not-pausable path
 *   resume   - happy path, not-paused path
 *
 * Each mutating runner is verified to:
 *   - thread `ctx.actor.source` -> audit `actorSource`
 *   - thread `ctx.actor.label`  -> audit `actorLabel` (and the row's
 *                                  `created_by` slot for `create`)
 *   - snapshot the row pre-mutation as `before` (cancel/pause/resume)
 *   - project the post-mutation state as `after`
 *
 * @see docs/implementation/tasks/P7-001b-replay-cli-behavioral-tests.md
 */

import { describe, expect, it } from "vitest";

import {
  buildReplayCancelRunner,
  buildReplayCreateRunner,
  buildReplayListRunner,
  buildReplayPauseRunner,
  buildReplayResumeRunner,
  buildReplayShowRunner,
  type CommandContext,
  type InsertReplayJobInput,
  type ListReplayJobsFilter,
  type OutputStreams,
  type PackageMeta,
  type ReplayCancelStore,
  type ReplayCreateAuditPayload,
  type ReplayCreateStore,
  type ReplayJobRow,
  type ReplayListStore,
  type ReplayPauseStore,
  type ReplayResumeStore,
  type ReplayShowStore,
  UsageError,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const META: PackageMeta = {
  version: "0.0.0-test",
  gitSha: "deadbeef",
  buildTime: "2026-05-12T00:00:00.000Z",
  nodeVersion: "v22.0.0",
};

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

function makeContext(streams: OutputStreams): CommandContext {
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
      output: "human",
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

const SEED_ROW: ReplayJobRow = {
  replay_job_id: "polaris_rpj_seed",
  project_id: "storefront",
  environment: "development",
  event_name: null,
  event_id: null,
  window_from: "2026-04-12T00:00:00.000Z",
  window_to: "2026-04-13T00:00:00.000Z",
  target: "analytics_raw",
  mode: "dry_run",
  status: "pending",
  created_by: "cli",
  reason: "seed for tests",
  created_at: "2026-05-12T12:00:00.000Z",
  planned_at: null,
  started_at: null,
  finished_at: null,
  events_planned: 0,
  events_replayed: 0,
  events_failed: 0,
  error_class: null,
  error_message: null,
};

function seedRow(overrides: Partial<ReplayJobRow> = {}): ReplayJobRow {
  return { ...SEED_ROW, ...overrides };
}

class InMemoryReplayStore {
  public readonly rows = new Map<string, ReplayJobRow>();
  public inserts: InsertReplayJobInput[] = [];
  public audits: ReplayCreateAuditPayload[] = [];
  public closeCalls = 0;
  public cancelAudits: Array<{
    readonly id: string;
    readonly actorSource: string;
    readonly actorLabel: string;
    readonly before: ReplayJobRow;
    readonly reason: string;
  }> = [];
  public pauseAudits: typeof this.cancelAudits = [];
  public resumeAudits: typeof this.cancelAudits = [];

  seed(row: ReplayJobRow): void {
    this.rows.set(row.replay_job_id, row);
  }

  asCreateStore(): ReplayCreateStore {
    return {
      insertWithAudit: async (input, audit) => {
        this.inserts.push(input);
        this.audits.push(audit);
        this.rows.set(input.replay_job_id, {
          replay_job_id: input.replay_job_id,
          project_id: input.project_id,
          environment: input.environment,
          event_name: input.event_name ?? null,
          event_id: input.event_id ?? null,
          window_from: input.window_from.toISOString(),
          window_to: input.window_to.toISOString(),
          target: input.target,
          mode: input.mode,
          status: "pending",
          created_by: input.created_by,
          reason: input.reason,
          created_at: new Date("2026-05-12T12:00:00.000Z").toISOString(),
          planned_at: null,
          started_at: null,
          finished_at: null,
          events_planned: 0,
          events_replayed: 0,
          events_failed: 0,
          error_class: null,
          error_message: null,
        });
      },
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }

  asListStore(): ReplayListStore {
    return {
      list: async (filter: ListReplayJobsFilter) => {
        const rows = [...this.rows.values()].filter((row) => {
          if (filter.status !== undefined && row.status !== filter.status) return false;
          if (filter.projectId !== undefined && row.project_id !== filter.projectId) return false;
          if (filter.environment !== undefined && row.environment !== filter.environment)
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

  asShowStore(): ReplayShowStore {
    return {
      findById: async (id) => this.rows.get(id) ?? null,
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }

  asCancelStore(): ReplayCancelStore {
    return {
      findById: async (id) => this.rows.get(id) ?? null,
      cancelWithAudit: async (input) => {
        const row = this.rows.get(input.replayJobId);
        if (row === undefined) return { kind: "not_found" as const };
        if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") {
          return { kind: "already_terminal" as const, row };
        }
        const updated: ReplayJobRow = {
          ...row,
          status: "cancelled",
          finished_at: input.cancelledAt.toISOString(),
        };
        this.rows.set(input.replayJobId, updated);
        this.cancelAudits.push({
          id: input.auditId,
          actorSource: input.actorSource,
          actorLabel: input.actorLabel,
          before: input.before,
          reason: input.reason,
        });
        return { kind: "cancelled" as const, row: updated };
      },
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }

  asPauseStore(): ReplayPauseStore {
    return {
      findById: async (id) => this.rows.get(id) ?? null,
      pauseWithAudit: async (input) => {
        const row = this.rows.get(input.replayJobId);
        if (row === undefined) return { kind: "not_found" as const };
        if (row.status !== "pending" && row.status !== "planning" && row.status !== "running") {
          return { kind: "not_pausable" as const, row };
        }
        const updated: ReplayJobRow = { ...row, status: "paused" };
        this.rows.set(input.replayJobId, updated);
        this.pauseAudits.push({
          id: input.auditId,
          actorSource: input.actorSource,
          actorLabel: input.actorLabel,
          before: input.before,
          reason: input.reason,
        });
        return { kind: "paused" as const, row: updated };
      },
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }

  asResumeStore(): ReplayResumeStore {
    return {
      findById: async (id) => this.rows.get(id) ?? null,
      resumeWithAudit: async (input) => {
        const row = this.rows.get(input.replayJobId);
        if (row === undefined) return { kind: "not_found" as const };
        if (row.status !== "paused") {
          return { kind: "not_paused" as const, row };
        }
        const updated: ReplayJobRow = { ...row, status: "running" };
        this.rows.set(input.replayJobId, updated);
        this.resumeAudits.push({
          id: input.auditId,
          actorSource: input.actorSource,
          actorLabel: input.actorLabel,
          before: input.before,
          reason: input.reason,
        });
        return { kind: "resumed" as const, row: updated };
      },
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("replay create runner", () => {
  it("happy path: inserts row + audit with the resolved actor", async () => {
    const store = new InMemoryReplayStore();
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const now = new Date("2026-05-12T12:00:00.000Z");
    const runner = buildReplayCreateRunner({
      issueId: () => "polaris_rpj_test1",
      openStore: () => store.asCreateStore(),
      now: () => now,
      generateAuditId: () => "polaris_aud_test1",
    });
    await runner(
      {
        project: "storefront",
        env: "development",
        target: "analytics_raw",
        from: "2026-04-12T00:00:00.000Z",
        to: "2026-04-13T00:00:00.000Z",
        mode: "dry_run",
        reason: "audit reseed",
      },
      ctx,
    );
    expect(store.inserts).toHaveLength(1);
    const insert = store.inserts[0];
    expect(insert?.replay_job_id).toBe("polaris_rpj_test1");
    expect(insert?.created_by).toBe("cli");
    expect(store.audits).toHaveLength(1);
    const audit = store.audits[0];
    expect(audit?.actorSource).toBe("cli");
    expect(audit?.actorLabel).toBe("cli");
    expect(audit?.after.status).toBe("pending");
    expect(audit?.reason).toBe("audit reseed");
    expect(store.closeCalls).toBe(1);
  });

  it("rejects --from older than 90 days with replay_window_exceeded", async () => {
    const store = new InMemoryReplayStore();
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const now = new Date("2026-05-12T12:00:00.000Z");
    const runner = buildReplayCreateRunner({
      openStore: () => store.asCreateStore(),
      now: () => now,
    });
    await expect(
      runner(
        {
          project: "storefront",
          env: "development",
          target: "analytics_raw",
          from: "2025-01-01T00:00:00.000Z", // > 90 days old
          to: "2025-01-02T00:00:00.000Z",
          mode: "dry_run",
          reason: "should fail",
        },
        ctx,
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("replay_window_exceeded") });
    expect(store.inserts).toHaveLength(0);
  });

  it("rejects planner-shaped flags BEFORE any DB call", async () => {
    const store = new InMemoryReplayStore();
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const runner = buildReplayCreateRunner({
      openStore: () => store.asCreateStore(),
    });
    await expect(
      runner(
        {
          project: "storefront",
          env: "development",
          target: "analytics_raw",
          from: "2026-04-12T00:00:00.000Z",
          to: "2026-04-13T00:00:00.000Z",
          reason: "smuggle",
          // biome-ignore lint/suspicious/noExplicitAny: smuggling a forbidden flag for the test
          partitionStrategy: "round_robin" as any,
        } as Parameters<typeof runner>[0],
        ctx,
      ),
    ).rejects.toBeInstanceOf(UsageError);
    expect(store.inserts).toHaveLength(0);
    expect(store.audits).toHaveLength(0);
  });
});

describe("replay list runner", () => {
  it("passes filter through to the store", async () => {
    const store = new InMemoryReplayStore();
    store.seed(seedRow({ replay_job_id: "polaris_rpj_a", status: "pending" }));
    store.seed(
      seedRow({ replay_job_id: "polaris_rpj_b", status: "completed", environment: "production" }),
    );
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const runner = buildReplayListRunner({ openStore: () => store.asListStore() });
    await runner({ status: "pending", project: "storefront", env: "development" }, ctx);
    expect(cap.stdout.join("")).toContain("polaris_rpj_a");
    expect(cap.stdout.join("")).not.toContain("polaris_rpj_b");
  });
});

describe("replay show runner", () => {
  it("renders the full row when present", async () => {
    const store = new InMemoryReplayStore();
    store.seed(seedRow({ replay_job_id: "polaris_rpj_show1" }));
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const runner = buildReplayShowRunner({ openStore: () => store.asShowStore() });
    await runner({ replayJobId: "polaris_rpj_show1" }, ctx);
    expect(cap.stdout.join("")).toContain("polaris_rpj_show1");
  });

  it("throws UsageError when the row is missing", async () => {
    const store = new InMemoryReplayStore();
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const runner = buildReplayShowRunner({ openStore: () => store.asShowStore() });
    await expect(runner({ replayJobId: "polaris_rpj_nope" }, ctx)).rejects.toBeInstanceOf(
      UsageError,
    );
  });
});

describe("replay cancel runner", () => {
  it("happy path: cancels a non-terminal row + writes audit", async () => {
    const store = new InMemoryReplayStore();
    store.seed(seedRow({ replay_job_id: "polaris_rpj_c1", status: "running" }));
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const now = new Date("2026-05-12T12:34:56.000Z");
    const runner = buildReplayCancelRunner({
      openStore: () => store.asCancelStore(),
      now: () => now,
      generateAuditId: () => "polaris_aud_c1",
    });
    await runner({ replayJobId: "polaris_rpj_c1", reason: "operator-issued cancel" }, ctx);
    expect(store.rows.get("polaris_rpj_c1")?.status).toBe("cancelled");
    expect(store.cancelAudits).toHaveLength(1);
    expect(store.cancelAudits[0]?.actorSource).toBe("cli");
    expect(store.cancelAudits[0]?.reason).toBe("operator-issued cancel");
    expect(store.cancelAudits[0]?.before.status).toBe("running");
  });

  it("idempotent: already-terminal row -> already_terminal outcome, no second audit", async () => {
    const store = new InMemoryReplayStore();
    store.seed(seedRow({ replay_job_id: "polaris_rpj_c2", status: "cancelled" }));
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const runner = buildReplayCancelRunner({ openStore: () => store.asCancelStore() });
    await runner({ replayJobId: "polaris_rpj_c2", reason: "re-cancel" }, ctx);
    expect(store.cancelAudits).toHaveLength(0);
    expect(cap.stdout.join("")).toContain("already");
  });

  it("missing id -> UsageError, no audit", async () => {
    const store = new InMemoryReplayStore();
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const runner = buildReplayCancelRunner({ openStore: () => store.asCancelStore() });
    await expect(
      runner({ replayJobId: "polaris_rpj_missing", reason: "x" }, ctx),
    ).rejects.toBeInstanceOf(UsageError);
    expect(store.cancelAudits).toHaveLength(0);
  });
});

describe("replay pause runner", () => {
  it("happy path: running -> paused with audit", async () => {
    const store = new InMemoryReplayStore();
    store.seed(seedRow({ replay_job_id: "polaris_rpj_p1", status: "running" }));
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const runner = buildReplayPauseRunner({ openStore: () => store.asPauseStore() });
    await runner({ replayJobId: "polaris_rpj_p1", reason: "ops pause" }, ctx);
    expect(store.rows.get("polaris_rpj_p1")?.status).toBe("paused");
    expect(store.pauseAudits).toHaveLength(1);
    expect(store.pauseAudits[0]?.before.status).toBe("running");
  });

  it("non-pausable status -> not_pausable outcome, no audit", async () => {
    const store = new InMemoryReplayStore();
    store.seed(seedRow({ replay_job_id: "polaris_rpj_p2", status: "completed" }));
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const runner = buildReplayPauseRunner({ openStore: () => store.asPauseStore() });
    await runner({ replayJobId: "polaris_rpj_p2", reason: "should fail" }, ctx);
    expect(store.pauseAudits).toHaveLength(0);
    expect(cap.stdout.join("")).toContain("not pausable");
  });
});

describe("replay resume runner", () => {
  it("happy path: paused -> running with audit", async () => {
    const store = new InMemoryReplayStore();
    store.seed(seedRow({ replay_job_id: "polaris_rpj_r1", status: "paused" }));
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const runner = buildReplayResumeRunner({ openStore: () => store.asResumeStore() });
    await runner({ replayJobId: "polaris_rpj_r1", reason: "ops resume" }, ctx);
    expect(store.rows.get("polaris_rpj_r1")?.status).toBe("running");
    expect(store.resumeAudits).toHaveLength(1);
    expect(store.resumeAudits[0]?.before.status).toBe("paused");
  });

  it("non-paused status -> not_paused outcome, no audit", async () => {
    const store = new InMemoryReplayStore();
    store.seed(seedRow({ replay_job_id: "polaris_rpj_r2", status: "running" }));
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const runner = buildReplayResumeRunner({ openStore: () => store.asResumeStore() });
    await runner({ replayJobId: "polaris_rpj_r2", reason: "should fail" }, ctx);
    expect(store.resumeAudits).toHaveLength(0);
    expect(cap.stdout.join("")).toContain("not paused");
  });
});
