/**
 * Behavioral tests for the `polaris replay plan` runner (P7-002).
 *
 * The plan command is the dry-run renderer for a replay job. It reads
 * the operator-issued declaration out of `replay_jobs`, hands it to the
 * planner in `@polaris/shared-replay`, and prints the result. No DB
 * writes; no Redpanda reads.
 *
 * Coverage matrix:
 *
 *   happy path        valid row -> plan rendered as human text
 *   json output       --output json swaps the renderer
 *   missing id        unknown replay_job_id -> UsageError
 *   stale declaration row's window_from older than retention ->
 *                     UsageError carrying the planner's structured code
 *   defense in depth  planner-shaped flag rejected before any store read
 *   default disabled  destinations target -> destinations_enabled=false
 *                     in the rendered plan
 *   determinism       same row + same clock -> same plan
 *
 * @see docs/implementation/tasks/P7-002-replay-planner-dry-run.md
 */

import { describe, expect, it } from "vitest";

import {
  buildReplayPlanRunner,
  type CommandContext,
  type OutputStreams,
  type PackageMeta,
  type ReplayJobRow,
  type ReplayPlanStore,
  UsageError,
} from "../src/index.js";

const META: PackageMeta = {
  version: "0.0.0-test",
  gitSha: "deadbeef",
  buildTime: "2026-05-12T00:00:00.000Z",
  nodeVersion: "v22.0.0",
};

const NOW = new Date("2026-05-12T12:00:00.000Z");

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

const SEED_ROW: ReplayJobRow = {
  replay_job_id: "polaris_rpj_seed",
  project_id: "storefront",
  environment: "development",
  event_name: null,
  event_id: null,
  window_from: "2026-05-10T00:00:00.000Z",
  window_to: "2026-05-11T00:00:00.000Z",
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
};

function seedRow(overrides: Partial<ReplayJobRow> = {}): ReplayJobRow {
  return { ...SEED_ROW, ...overrides };
}

class InMemoryPlanStore {
  public readonly rows = new Map<string, ReplayJobRow>();
  public closeCalls = 0;

  seed(row: ReplayJobRow): void {
    this.rows.set(row.replay_job_id, row);
  }

  asStore(): ReplayPlanStore {
    return {
      findById: async (id) => this.rows.get(id) ?? null,
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }
}

describe("replay plan runner", () => {
  it("happy path: renders the plan as human text", async () => {
    const store = new InMemoryPlanStore();
    store.seed(seedRow());
    const cap = captureOutput();
    const ctx = makeContext(cap.streams, "human");
    const runner = buildReplayPlanRunner({
      openStore: () => store.asStore(),
      now: () => NOW,
    });
    await runner({ replayJobId: "polaris_rpj_seed" }, ctx);
    const out = cap.stdout.join("");
    expect(out).toContain("polaris replay plan (dry-run; planner v1)");
    expect(out).toContain("source_topic_family    raw.events");
    expect(out).toContain("project_id             storefront");
    expect(out).toContain("environment            development");
    expect(out).toContain("target                 analytics_raw");
    expect(out).toContain(
      "consumer_group         polaris-replay.storefront.development.analytics_raw.polaris_rpj_seed",
    );
    expect(out).toContain("events_estimated       unknown");
    expect(store.closeCalls).toBe(1);
  });

  it("--output json renders the full plan structure", async () => {
    const store = new InMemoryPlanStore();
    store.seed(seedRow());
    const cap = captureOutput();
    const ctx = makeContext(cap.streams, "json");
    const runner = buildReplayPlanRunner({
      openStore: () => store.asStore(),
      now: () => NOW,
    });
    await runner({ replayJobId: "polaris_rpj_seed" }, ctx);
    const text = cap.stdout.join("");
    const parsed = JSON.parse(text);
    expect(parsed).toMatchObject({
      replay_job_id: "polaris_rpj_seed",
      project_id: "storefront",
      environment: "development",
      target: "analytics_raw",
      mode: "dry_run",
      source_topic_family: "raw.events",
      partition_key_strategy: "project_environment_identity",
      destinations_enabled: false,
      destination_opt_in_note: null,
      events_estimated: null,
      planner_version: "v1",
    });
    expect(parsed.risks).toEqual([]);
    expect(parsed.chunks).toHaveLength(1);
  });

  it("destination target defaults to destinations_enabled=false in the plan", async () => {
    // The CLI cannot ship destinations_enabled=true today (P7-001's row
    // schema does not persist it). The planner therefore always lands
    // on `false` for a destination-target row; the default-disabled
    // architecture rule is upheld end-to-end.
    const store = new InMemoryPlanStore();
    store.seed(seedRow({ replay_job_id: "polaris_rpj_dest", target: "destinations" }));
    const cap = captureOutput();
    const ctx = makeContext(cap.streams, "json");
    const runner = buildReplayPlanRunner({
      openStore: () => store.asStore(),
      now: () => NOW,
    });
    await runner({ replayJobId: "polaris_rpj_dest" }, ctx);
    const parsed = JSON.parse(cap.stdout.join(""));
    expect(parsed.target).toBe("destinations");
    expect(parsed.destinations_enabled).toBe(false);
    expect(parsed.destination_opt_in_note).toBeNull();
    // destination_sends_enabled risk must NOT fire in the default case.
    const codes = (parsed.risks as Array<{ code: string }>).map((r) => r.code);
    expect(codes).not.toContain("destination_sends_enabled");
  });

  it("processor target without pinned name/version flags processor_target_not_pinned", async () => {
    const store = new InMemoryPlanStore();
    store.seed(seedRow({ replay_job_id: "polaris_rpj_proc", target: "processor" }));
    const cap = captureOutput();
    const ctx = makeContext(cap.streams, "json");
    const runner = buildReplayPlanRunner({
      openStore: () => store.asStore(),
      now: () => NOW,
    });
    await runner({ replayJobId: "polaris_rpj_proc" }, ctx);
    const parsed = JSON.parse(cap.stdout.join(""));
    const codes = (parsed.risks as Array<{ code: string }>).map((r) => r.code);
    expect(codes).toContain("processor_target_not_pinned");
  });

  it("production scope flags production_scope risk", async () => {
    const store = new InMemoryPlanStore();
    store.seed(seedRow({ replay_job_id: "polaris_rpj_prod", environment: "production" }));
    const cap = captureOutput();
    const ctx = makeContext(cap.streams, "json");
    const runner = buildReplayPlanRunner({
      openStore: () => store.asStore(),
      now: () => NOW,
    });
    await runner({ replayJobId: "polaris_rpj_prod" }, ctx);
    const parsed = JSON.parse(cap.stdout.join(""));
    const codes = (parsed.risks as Array<{ code: string }>).map((r) => r.code);
    expect(codes).toContain("production_scope");
  });

  it("missing id -> UsageError, no rendering", async () => {
    const store = new InMemoryPlanStore();
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const runner = buildReplayPlanRunner({
      openStore: () => store.asStore(),
      now: () => NOW,
    });
    await expect(runner({ replayJobId: "polaris_rpj_missing" }, ctx)).rejects.toBeInstanceOf(
      UsageError,
    );
    expect(cap.stdout.join("")).toBe("");
  });

  it("empty id -> UsageError", async () => {
    const store = new InMemoryPlanStore();
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const runner = buildReplayPlanRunner({
      openStore: () => store.asStore(),
      now: () => NOW,
    });
    await expect(runner({ replayJobId: "   " }, ctx)).rejects.toBeInstanceOf(UsageError);
  });

  it("stale row (window_from older than retention) -> UsageError with structured code", async () => {
    const store = new InMemoryPlanStore();
    store.seed(
      seedRow({
        replay_job_id: "polaris_rpj_stale",
        window_from: "2025-01-01T00:00:00.000Z",
        window_to: "2025-01-02T00:00:00.000Z",
      }),
    );
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const runner = buildReplayPlanRunner({
      openStore: () => store.asStore(),
      now: () => NOW,
    });
    await expect(runner({ replayJobId: "polaris_rpj_stale" }, ctx)).rejects.toMatchObject({
      message: expect.stringContaining("replay_plan_rejected:outside_retention_window"),
    });
  });

  it("rejects planner-shaped flags BEFORE any store read", async () => {
    const store = new InMemoryPlanStore();
    store.seed(seedRow());
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const runner = buildReplayPlanRunner({
      openStore: () => store.asStore(),
      now: () => NOW,
    });
    await expect(
      runner(
        {
          replayJobId: "polaris_rpj_seed",
          // biome-ignore lint/suspicious/noExplicitAny: smuggling a forbidden flag for the test
          partitionStrategy: "round_robin" as any,
        } as Parameters<typeof runner>[0],
        ctx,
      ),
    ).rejects.toBeInstanceOf(UsageError);
    expect(store.closeCalls).toBe(0);
  });

  it("closes the store even when the planner rejects", async () => {
    const store = new InMemoryPlanStore();
    store.seed(
      seedRow({
        replay_job_id: "polaris_rpj_stale",
        window_from: "2025-01-01T00:00:00.000Z",
        window_to: "2025-01-02T00:00:00.000Z",
      }),
    );
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const runner = buildReplayPlanRunner({
      openStore: () => store.asStore(),
      now: () => NOW,
    });
    await expect(runner({ replayJobId: "polaris_rpj_stale" }, ctx)).rejects.toBeInstanceOf(
      UsageError,
    );
    expect(store.closeCalls).toBe(1);
  });

  it("determinism: same row + same clock -> identical plan output", async () => {
    const store = new InMemoryPlanStore();
    store.seed(seedRow());
    const cap1 = captureOutput();
    const cap2 = captureOutput();
    const ctx1 = makeContext(cap1.streams, "json");
    const ctx2 = makeContext(cap2.streams, "json");
    const runner = buildReplayPlanRunner({
      openStore: () => store.asStore(),
      now: () => NOW,
    });
    await runner({ replayJobId: "polaris_rpj_seed" }, ctx1);
    await runner({ replayJobId: "polaris_rpj_seed" }, ctx2);
    expect(cap1.stdout.join("")).toBe(cap2.stdout.join(""));
  });
});
