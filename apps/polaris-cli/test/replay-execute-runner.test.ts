/**
 * Behavioral tests for the `polaris replay execute` runner (P7-003).
 *
 * The execute command picks up a replay-job row, derives the
 * deterministic plan via `@polaris/archive-replay`, and runs the
 * executor against an injected source/producer/store. The runner is
 * the only CLI seam that turns the executor's lifecycle transitions
 * (`pending|planning -> running -> completed | failed | aborted`) into
 * stamped `replay_jobs` rows.
 *
 * Coverage matrix (mirrors the P7-003 acceptance criteria):
 *
 *   happy path             - live processor plan + emitted events -> row
 *                            transitions to `completed` with counters
 *                            matching the producer's publish count.
 *
 *   dry-run refusal        - row with mode=`dry_run` -> UsageError with
 *                            `replay_executor_refused:plan_is_dry_run`.
 *
 *   not-found              - unknown replay_job_id -> UsageError.
 *
 *   missing-id             - empty arg -> UsageError.
 *
 *   stale-row planner      - row whose window_from is older than the
 *                            retention window -> UsageError carrying the
 *                            planner's structured code.
 *
 *   processor-not-pinned   - row with target=processor but no pin (P7-001
 *                            does not persist them) -> UsageError carrying
 *                            the executor's structured code.
 *
 *   peer cancellation      - operator cancelled the row mid-flight ->
 *                            outcome status `aborted`, partial counters
 *                            stamped.
 *
 *   failure persistence    - source.fetchChunk throws -> row transitions
 *                            to `failed`, error_class + error_message
 *                            persisted on the row.
 *
 *   replay header lineage  - every emitted ProduceRecord carries the
 *                            `polaris-replay` + `polaris-replay-job-id`
 *                            headers stamped by the executor.
 *
 *   planner flag rejection - smuggling a planner-shaped flag through the
 *                            execute surface -> UsageError before any
 *                            store read.
 *
 *   close on error         - the store's `close` always fires (try /
 *                            finally guarantee).
 *
 * @see docs/implementation/tasks/P7-003-processor-replay-executor.md
 */

import {
  REPLAY_HEADER_FLAG,
  REPLAY_HEADER_JOB_ID,
  type ReplayChunkProgress,
  type ReplayExecutorProducer,
  type ReplayExecutorSource,
  type ReplayMarkCompletedInput,
  type ReplayMarkFailedInput,
  type ReplayMarkRunningInput,
  type ReplayProduceRecord,
  type ReplaySourceEvent,
} from "@polaris/archive-replay";
import {
  POLARIS_HEADER_ENVIRONMENT,
  POLARIS_HEADER_EVENT_ID,
  POLARIS_HEADER_EVENT_NAME,
  POLARIS_HEADER_INGESTED_AT,
  POLARIS_HEADER_OCCURRED_AT,
  POLARIS_HEADER_PROJECT_ID,
  type StreamRangeDelivery,
  type StreamRangeDriver,
} from "@polaris/bus";
import { describe, expect, it } from "vitest";

import { buildStreamReplaySource } from "../src/commands/replay/stream-adapters.js";
import {
  buildReplayExecuteRunner,
  type CommandContext,
  type OutputStreams,
  type PackageMeta,
  type ReplayExecuteStore,
  type ReplayJobRow,
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
    actor: { source: "cli", label: "operator-1" },
  };
}

// The default seed uses target=`analytics_raw` because P7-001's row
// schema does not persist `processor_name`/`processor_version`; the
// planner emits the `processor_target_not_pinned` risk and the
// executor refuses to ship those rows. The processor-not-pinned
// refusal path has its own test below.
const SEED_ROW: ReplayJobRow = {
  replay_job_id: "polaris_rpj_exec",
  project_id: "storefront",
  environment: "development",
  event_name: null,
  event_id: null,
  // 1-day window so chunking remains deterministic.
  window_from: "2026-05-10T00:00:00.000Z",
  window_to: "2026-05-11T00:00:00.000Z",
  target: "analytics_raw",
  mode: "live",
  status: "pending",
  created_by: "operator-1",
  reason: "P7-003 executor smoke",
  created_at: "2026-05-12T11:00:00.000Z",
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

// ---------------------------------------------------------------------------
// In-memory store (mirrors the real Kysely setters)
// ---------------------------------------------------------------------------

class InMemoryExecuteStore {
  public readonly rows = new Map<string, ReplayJobRow>();
  public closeCalls = 0;
  public runningCalls: ReplayMarkRunningInput[] = [];
  public chunkCalls: ReplayChunkProgress[] = [];
  public completedCalls: ReplayMarkCompletedInput[] = [];
  public failedCalls: ReplayMarkFailedInput[] = [];
  // Pre-loaded post-chunk status overrides so a test can simulate the
  // operator flipping the row to `cancelled` between chunks.
  public statusAfterChunk: string[] = [];

  seed(row: ReplayJobRow): void {
    this.rows.set(row.replay_job_id, { ...row });
  }

  armedAudit: ReplayExecuteAuditContext | null = null;

  asStore(): ReplayExecuteStore {
    return {
      findById: async (id) => this.rows.get(id) ?? null,
      // The in-memory double writes no audit row; the audited transition is
      // covered by persistence-control-plane's own suite. What matters here is
      // that the runner arms it before executing — asserted below.
      armAudit: (context) => {
        this.armedAudit = context;
      },
      markRunning: async (input) => {
        this.runningCalls.push(input);
        const row = this.rows.get(input.replay_job_id);
        if (row === undefined) return null;
        if (row.status === "pending" || row.status === "planning") {
          const next: ReplayJobRow = {
            ...row,
            status: "running",
            events_planned: input.events_planned,
            started_at: input.now.toISOString(),
          };
          this.rows.set(input.replay_job_id, next);
        }
        const after = this.rows.get(input.replay_job_id) ?? null;
        if (after === null) return null;
        return {
          status: after.status,
          events_planned: after.events_planned,
          events_replayed: after.events_replayed,
          events_failed: after.events_failed,
        };
      },
      recordChunkProgress: async (input) => {
        this.chunkCalls.push(input);
        const row = this.rows.get(input.replay_job_id);
        if (row !== undefined && row.status === "running") {
          this.rows.set(input.replay_job_id, {
            ...row,
            events_replayed: input.cumulative_emitted,
            events_failed: input.cumulative_failed,
          });
        }
        const override = this.statusAfterChunk.shift();
        if (override !== undefined && row !== undefined) {
          const r2 = this.rows.get(input.replay_job_id);
          if (r2 !== undefined) {
            this.rows.set(input.replay_job_id, {
              ...r2,
              status: override as ReplayJobRow["status"],
            });
          }
        }
        const after = this.rows.get(input.replay_job_id) ?? null;
        return {
          status: after?.status ?? "completed",
          events_planned: after?.events_planned ?? 0,
          events_replayed: after?.events_replayed ?? input.cumulative_emitted,
          events_failed: after?.events_failed ?? input.cumulative_failed,
        };
      },
      markCompleted: async (input) => {
        this.completedCalls.push(input);
        const row = this.rows.get(input.replay_job_id);
        if (row !== undefined && row.status === "running") {
          this.rows.set(input.replay_job_id, {
            ...row,
            status: "completed",
            finished_at: input.now.toISOString(),
            events_replayed: input.events_replayed,
            events_failed: input.events_failed,
          });
          return true;
        }
        return false;
      },
      markFailed: async (input) => {
        this.failedCalls.push(input);
        const row = this.rows.get(input.replay_job_id);
        if (row !== undefined && row.status === "running") {
          this.rows.set(input.replay_job_id, {
            ...row,
            status: "failed",
            finished_at: input.now.toISOString(),
            events_replayed: input.events_replayed,
            events_failed: input.events_failed,
            error_class: input.error_class,
            error_message: input.error_message,
          });
          return true;
        }
        return false;
      },
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }
}

// ---------------------------------------------------------------------------
// In-memory source + producer
// ---------------------------------------------------------------------------

function makeSource(events: ReadonlyArray<ReplaySourceEvent>): ReplayExecutorSource {
  return {
    async fetchChunk() {
      return events;
    },
  };
}

function makeFailingSource(err: Error): ReplayExecutorSource {
  return {
    async fetchChunk() {
      throw err;
    },
  };
}

function makeRecordingProducer(): {
  producer: ReplayExecutorProducer;
  records: ReplayProduceRecord[];
} {
  const records: ReplayProduceRecord[] = [];
  return {
    records,
    producer: {
      async publish(record) {
        records.push(record);
      },
    },
  };
}

function event(overrides: Partial<ReplaySourceEvent> = {}): ReplaySourceEvent {
  return {
    event_id: "ev_a",
    event_name: "purchase",
    project_id: "storefront",
    environment: "development",
    occurred_at: "2026-05-10T03:00:00.000Z",
    partition_key: "storefront.development.user.42",
    value: new Uint8Array([1, 2, 3]),
    headers: { "polaris-event-id": "ev_a" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("replay execute runner — happy path", () => {
  it("transitions the row to `completed` and stamps counters", async () => {
    const store = new InMemoryExecuteStore();
    store.seed(seedRow());
    const cap = captureOutput();
    const ctx = makeContext(cap.streams, "json");
    const { producer, records } = makeRecordingProducer();
    const runner = buildReplayExecuteRunner({
      openStore: () => store.asStore(),
      source: () => makeSource([event(), event({ event_id: "ev_b" })]),
      producer: () => producer,
      now: () => NOW,
    });

    await runner({ replayJobId: "polaris_rpj_exec" }, ctx);

    const after = store.rows.get("polaris_rpj_exec");
    expect(after?.status).toBe("completed");
    expect(after?.events_replayed).toBe(2);
    expect(after?.events_failed).toBe(0);
    expect(after?.started_at).toBe(NOW.toISOString());
    expect(after?.finished_at).toBe(NOW.toISOString());
    expect(store.completedCalls).toHaveLength(1);
    expect(store.failedCalls).toHaveLength(0);
    expect(records).toHaveLength(2);

    const parsed = JSON.parse(cap.stdout.join("")) as {
      status: string;
      events_replayed: number;
      events_failed: number;
    };
    expect(parsed.status).toBe("completed");
    expect(parsed.events_replayed).toBe(2);
    expect(parsed.events_failed).toBe(0);
    expect(store.closeCalls).toBe(1);
  });

  it("stamps the platform replay headers on every produced record", async () => {
    const store = new InMemoryExecuteStore();
    store.seed(seedRow());
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const { producer, records } = makeRecordingProducer();
    const runner = buildReplayExecuteRunner({
      openStore: () => store.asStore(),
      source: () => makeSource([event(), event({ event_id: "ev_b" })]),
      producer: () => producer,
      now: () => NOW,
    });
    await runner({ replayJobId: "polaris_rpj_exec" }, ctx);
    for (const rec of records) {
      expect(rec.headers[REPLAY_HEADER_FLAG]).toBe("true");
      expect(rec.headers[REPLAY_HEADER_JOB_ID]).toBe("polaris_rpj_exec");
      // Original headers survive.
      expect(rec.headers["polaris-event-id"]).toBeDefined();
    }
  });

  it("renders human output when --output is human", async () => {
    const store = new InMemoryExecuteStore();
    store.seed(seedRow());
    const cap = captureOutput();
    const ctx = makeContext(cap.streams, "human");
    const { producer } = makeRecordingProducer();
    const runner = buildReplayExecuteRunner({
      openStore: () => store.asStore(),
      source: () => makeSource([event()]),
      producer: () => producer,
      now: () => NOW,
    });
    await runner({ replayJobId: "polaris_rpj_exec" }, ctx);
    const out = cap.stdout.join("");
    expect(out).toContain("polaris replay execute outcome");
    expect(out).toContain("replay_job_id    polaris_rpj_exec");
    expect(out).toContain("status           completed");
    expect(out).toContain("events_replayed  1");
  });

  it("respects --target-topic override", async () => {
    const store = new InMemoryExecuteStore();
    store.seed(seedRow());
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const { producer, records } = makeRecordingProducer();
    const runner = buildReplayExecuteRunner({
      openStore: () => store.asStore(),
      source: () => makeSource([event()]),
      producer: () => producer,
      now: () => NOW,
    });
    await runner({ replayJobId: "polaris_rpj_exec", targetTopic: "replay.events" }, ctx);
    expect(records[0]?.topic).toBe("replay.events");
  });
});

describe("replay execute runner — refusals", () => {
  it("refuses a dry_run row", async () => {
    const store = new InMemoryExecuteStore();
    store.seed(seedRow({ mode: "dry_run" }));
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const { producer } = makeRecordingProducer();
    const runner = buildReplayExecuteRunner({
      openStore: () => store.asStore(),
      source: () => makeSource([event()]),
      producer: () => producer,
      now: () => NOW,
    });
    await expect(runner({ replayJobId: "polaris_rpj_exec" }, ctx)).rejects.toMatchObject({
      message: expect.stringContaining("replay_executor_refused:plan_is_dry_run"),
    });
    // Lifecycle untouched.
    expect(store.runningCalls).toHaveLength(0);
    expect(store.completedCalls).toHaveLength(0);
    expect(store.failedCalls).toHaveLength(0);
    expect(store.closeCalls).toBe(1);
  });

  it("refuses an unknown id", async () => {
    const store = new InMemoryExecuteStore();
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const { producer } = makeRecordingProducer();
    const runner = buildReplayExecuteRunner({
      openStore: () => store.asStore(),
      source: () => makeSource([]),
      producer: () => producer,
      now: () => NOW,
    });
    await expect(runner({ replayJobId: "polaris_rpj_missing" }, ctx)).rejects.toBeInstanceOf(
      UsageError,
    );
    expect(store.closeCalls).toBe(1);
  });

  it("refuses an empty id", async () => {
    const store = new InMemoryExecuteStore();
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const { producer } = makeRecordingProducer();
    const runner = buildReplayExecuteRunner({
      openStore: () => store.asStore(),
      source: () => makeSource([]),
      producer: () => producer,
      now: () => NOW,
    });
    await expect(runner({ replayJobId: "   " }, ctx)).rejects.toBeInstanceOf(UsageError);
  });

  it("surfaces the planner's structured code for a stale row", async () => {
    const store = new InMemoryExecuteStore();
    store.seed(
      seedRow({
        window_from: "2025-01-01T00:00:00.000Z",
        window_to: "2025-01-02T00:00:00.000Z",
      }),
    );
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const { producer } = makeRecordingProducer();
    const runner = buildReplayExecuteRunner({
      openStore: () => store.asStore(),
      source: () => makeSource([]),
      producer: () => producer,
      now: () => NOW,
    });
    await expect(runner({ replayJobId: "polaris_rpj_exec" }, ctx)).rejects.toMatchObject({
      message: expect.stringContaining("replay_plan_rejected:outside_retention_window"),
    });
  });

  it("refuses processor-target rows without pinned name/version", async () => {
    // P7-001's row schema does not persist processor_name /
    // processor_version, so a processor-target row always lacks the
    // pin. The executor refuses with `processor_target_not_pinned`.
    const store = new InMemoryExecuteStore();
    store.seed(seedRow({ target: "processor" }));
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const { producer } = makeRecordingProducer();
    const runner = buildReplayExecuteRunner({
      openStore: () => store.asStore(),
      source: () => makeSource([]),
      producer: () => producer,
      now: () => NOW,
    });
    await expect(runner({ replayJobId: "polaris_rpj_exec" }, ctx)).rejects.toMatchObject({
      message: expect.stringContaining("replay_executor_refused:processor_target_not_pinned"),
    });
    expect(store.runningCalls).toHaveLength(0);
  });

  it("rejects planner-shaped flags BEFORE any store read", async () => {
    const store = new InMemoryExecuteStore();
    store.seed(seedRow());
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const { producer } = makeRecordingProducer();
    const runner = buildReplayExecuteRunner({
      openStore: () => store.asStore(),
      source: () => makeSource([]),
      producer: () => producer,
      now: () => NOW,
    });
    await expect(
      runner(
        {
          replayJobId: "polaris_rpj_exec",
          // biome-ignore lint/suspicious/noExplicitAny: smuggling forbidden flag
          partitionStrategy: "round_robin" as any,
        } as Parameters<typeof runner>[0],
        ctx,
      ),
    ).rejects.toBeInstanceOf(UsageError);
    // No store mutation.
    expect(store.closeCalls).toBe(0);
  });
});

describe("replay execute runner — failure path", () => {
  it("persists error_class + error_message on the row when the source throws", async () => {
    const store = new InMemoryExecuteStore();
    store.seed(seedRow());
    const cap = captureOutput();
    const ctx = makeContext(cap.streams, "json");
    const { producer } = makeRecordingProducer();
    const runner = buildReplayExecuteRunner({
      openStore: () => store.asStore(),
      source: () => makeFailingSource(new TypeError("kafka offline")),
      producer: () => producer,
      now: () => NOW,
    });
    await runner({ replayJobId: "polaris_rpj_exec" }, ctx);

    const after = store.rows.get("polaris_rpj_exec");
    expect(after?.status).toBe("failed");
    expect(after?.error_class).toBe("TypeError");
    expect(after?.error_message).toBe("kafka offline");
    expect(store.failedCalls).toHaveLength(1);
    expect(store.completedCalls).toHaveLength(0);

    const parsed = JSON.parse(cap.stdout.join("")) as {
      status: string;
      error: { error_class: string; error_message: string };
    };
    expect(parsed.status).toBe("failed");
    expect(parsed.error.error_class).toBe("TypeError");
    expect(parsed.error.error_message).toBe("kafka offline");
  });
});

describe("replay execute runner — cooperative cancel", () => {
  it("aborts cleanly when the operator flips the row to `cancelled` mid-flight", async () => {
    const store = new InMemoryExecuteStore();
    store.seed(seedRow());
    store.statusAfterChunk.push("cancelled");
    const cap = captureOutput();
    const ctx = makeContext(cap.streams, "json");
    const { producer, records } = makeRecordingProducer();
    const runner = buildReplayExecuteRunner({
      openStore: () => store.asStore(),
      source: () => makeSource([event()]),
      producer: () => producer,
      now: () => NOW,
    });
    await runner({ replayJobId: "polaris_rpj_exec" }, ctx);

    const parsed = JSON.parse(cap.stdout.join("")) as { status: string };
    expect(parsed.status).toBe("aborted");
    expect(records).toHaveLength(1);
    expect(store.completedCalls).toHaveLength(0);
    expect(store.failedCalls).toHaveLength(0);

    const after = store.rows.get("polaris_rpj_exec");
    expect(after?.status).toBe("cancelled");
    expect(after?.events_replayed).toBe(1);
  });
});

describe("replay execute runner — stream range reader wire-up", () => {
  it("threads the range reader's events through the executor and into the producer", async () => {
    // Synthesise deliveries carrying Polaris-shaped headers. The
    // adapter hands the chunk's time window straight to the reader —
    // streams attach by timestamp, so there is no time-to-offset
    // translation step any more. The reader projects the headers; the
    // adapter filters by plan scope; the executor stamps the replay
    // headers; the recording producer captures the outcome.
    const deliveries: StreamRangeDelivery[] = [
      {
        offset: "100",
        timestampMs: Date.parse("2026-05-10T03:00:00.000Z"),
        key: "storefront.development.user.42",
        value: new Uint8Array(Buffer.from("payload-a")),
        headers: {
          [POLARIS_HEADER_EVENT_ID]: "ev_a",
          [POLARIS_HEADER_EVENT_NAME]: "purchase",
          [POLARIS_HEADER_PROJECT_ID]: "storefront",
          [POLARIS_HEADER_ENVIRONMENT]: "development",
          [POLARIS_HEADER_OCCURRED_AT]: "2026-05-10T03:00:00.000Z",
          [POLARIS_HEADER_INGESTED_AT]: "2026-05-10T03:00:00.000Z",
        },
      },
      {
        offset: "101",
        timestampMs: Date.parse("2026-05-10T03:00:01.000Z"),
        key: "storefront.development.user.43",
        value: new Uint8Array(Buffer.from("payload-b")),
        headers: {
          [POLARIS_HEADER_EVENT_ID]: "ev_b",
          [POLARIS_HEADER_EVENT_NAME]: "purchase",
          [POLARIS_HEADER_PROJECT_ID]: "storefront",
          [POLARIS_HEADER_ENVIRONMENT]: "development",
          [POLARIS_HEADER_OCCURRED_AT]: "2026-05-10T03:00:01.000Z",
          [POLARIS_HEADER_INGESTED_AT]: "2026-05-10T03:00:01.000Z",
        },
      },
    ];

    function makeDriver(): StreamRangeDriver {
      return {
        async start({ onMessage }) {
          for (const delivery of deliveries) onMessage(delivery);
        },
        async release() {},
      };
    }

    const source = buildStreamReplaySource({
      family: "raw.events",
      partitions: 1,
      driverFactory: makeDriver,
      idleTimeoutMs: 20,
    });

    const store = new InMemoryExecuteStore();
    store.seed(seedRow());
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const { producer, records } = makeRecordingProducer();
    const runner = buildReplayExecuteRunner({
      openStore: () => store.asStore(),
      source: () => source,
      producer: () => producer,
      now: () => NOW,
    });

    await runner({ replayJobId: "polaris_rpj_exec" }, ctx);

    const after = store.rows.get("polaris_rpj_exec");
    expect(after?.status).toBe("completed");
    expect(after?.events_replayed).toBe(2);
    // The reader's events flowed through to the producer with the
    // executor's replay headers stamped on top.
    expect(records).toHaveLength(2);
    expect(records[0]?.source_event_id).toBe("ev_a");
    expect(records[0]?.headers[REPLAY_HEADER_FLAG]).toBe("true");
    expect(records[0]?.headers[REPLAY_HEADER_JOB_ID]).toBe("polaris_rpj_exec");
    expect(records[1]?.source_event_id).toBe("ev_b");
  });

  it("filters reader events by plan scope (project_id, environment, event_name)", async () => {
    // Reader returns two events: one matches the plan, one doesn't.
    const deliveries: StreamRangeDelivery[] = [
      {
        offset: "10",
        timestampMs: Date.parse("2026-05-10T03:00:00.000Z"),
        key: "storefront.development.user.1",
        value: new Uint8Array(Buffer.from("p1")),
        headers: {
          [POLARIS_HEADER_EVENT_ID]: "ev_keep",
          [POLARIS_HEADER_EVENT_NAME]: "purchase",
          [POLARIS_HEADER_PROJECT_ID]: "storefront",
          [POLARIS_HEADER_ENVIRONMENT]: "development",
          [POLARIS_HEADER_OCCURRED_AT]: "2026-05-10T03:00:00.000Z",
          [POLARIS_HEADER_INGESTED_AT]: "2026-05-10T03:00:00.000Z",
        },
      },
      {
        offset: "11",
        timestampMs: Date.parse("2026-05-10T03:00:01.000Z"),
        key: "other-project.development.user.2",
        value: new Uint8Array(Buffer.from("p2")),
        headers: {
          [POLARIS_HEADER_EVENT_ID]: "ev_drop",
          [POLARIS_HEADER_EVENT_NAME]: "purchase",
          [POLARIS_HEADER_PROJECT_ID]: "other-project",
          [POLARIS_HEADER_ENVIRONMENT]: "development",
          [POLARIS_HEADER_OCCURRED_AT]: "2026-05-10T03:00:01.000Z",
          [POLARIS_HEADER_INGESTED_AT]: "2026-05-10T03:00:01.000Z",
        },
      },
    ];

    function makeDriver(): StreamRangeDriver {
      return {
        async start({ onMessage }) {
          for (const delivery of deliveries) onMessage(delivery);
        },
        async release() {},
      };
    }

    const source = buildStreamReplaySource({
      family: "raw.events",
      partitions: 1,
      driverFactory: makeDriver,
      idleTimeoutMs: 20,
    });

    const store = new InMemoryExecuteStore();
    store.seed(seedRow());
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const { producer, records } = makeRecordingProducer();
    const runner = buildReplayExecuteRunner({
      openStore: () => store.asStore(),
      source: () => source,
      producer: () => producer,
      now: () => NOW,
    });

    await runner({ replayJobId: "polaris_rpj_exec" }, ctx);

    expect(records).toHaveLength(1);
    expect(records[0]?.source_event_id).toBe("ev_keep");
  });
});

describe("replay execute runner — invariants", () => {
  it("always closes the store, even on error", async () => {
    const store = new InMemoryExecuteStore();
    store.seed(seedRow({ mode: "dry_run" }));
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const { producer } = makeRecordingProducer();
    const runner = buildReplayExecuteRunner({
      openStore: () => store.asStore(),
      source: () => makeSource([]),
      producer: () => producer,
      now: () => NOW,
    });
    await expect(runner({ replayJobId: "polaris_rpj_exec" }, ctx)).rejects.toBeInstanceOf(
      UsageError,
    );
    expect(store.closeCalls).toBe(1);
  });

  it("arms the execute audit row with the resolved topic before running", async () => {
    // The audit row is what records WHO started a replay: replay_jobs
    // .created_by only says who created the job, and those differ whenever
    // one operator plans and another executes.
    const store = new InMemoryExecuteStore();
    store.seed(seedRow());
    const runner = buildReplayExecuteRunner({
      openStore: () => store.asStore(),
      source: () => makeSource([]),
      producer: () => makeRecordingProducer().producer,
      now: () => NOW,
    });
    await runner({ replayJobId: "polaris_rpj_exec" }, makeContext(captureOutput().streams));

    expect(store.armedAudit).not.toBeNull();
    expect(store.armedAudit?.actorLabel).toBe("operator-1");
    // raw.events feeds the destination consumers, so the row says so —
    // delivery still depends on each destination's replay_opt_in.
    expect(store.armedAudit?.targetTopic).toBe("raw.events");
    expect(store.armedAudit?.reachesDestinations).toBe(true);
  });

  it("records the --target-topic override in the audit row, not the default", async () => {
    const store = new InMemoryExecuteStore();
    store.seed(seedRow());
    const runner = buildReplayExecuteRunner({
      openStore: () => store.asStore(),
      source: () => makeSource([]),
      producer: () => makeRecordingProducer().producer,
      now: () => NOW,
    });
    await runner(
      { replayJobId: "polaris_rpj_exec", targetTopic: "session.events" },
      makeContext(captureOutput().streams),
    );

    expect(store.armedAudit?.targetTopic).toBe("session.events");
    // session.events has no destination consumer.
    expect(store.armedAudit?.reachesDestinations).toBe(false);
  });
});

describe("replay execute runner — the archive", () => {
  it("still rejects a stale row when the archive does not cover it", async () => {
    // The archive moves the retention bound; it does not remove it.
    const store = new InMemoryExecuteStore();
    store.seed(
      seedRow({
        window_from: "2020-01-01T00:00:00.000Z",
        window_to: "2020-01-02T00:00:00.000Z",
      }),
    );
    const cap = captureOutput();
    const ctx = makeContext(cap.streams);
    const { producer } = makeRecordingProducer();
    const runner = buildReplayExecuteRunner({
      openStore: () => store.asStore(),
      source: () => makeSource([]),
      producer: () => producer,
      archiveCoverage: async () => "2024-01-01",
      now: () => NOW,
    });

    await expect(runner({ replayJobId: "polaris_rpj_exec" }, ctx)).rejects.toMatchObject({
      message: expect.stringContaining("replay_plan_rejected:outside_retention_window"),
    });
  });

  it("plans and runs a window older than retention once the archive covers it", async () => {
    // Before this, the SAME row was an `outside_retention_window`
    // rejection — see the stale-row test above. The archive's coverage
    // answer is what turns it into a runnable job, which is the whole
    // point of the subsystem.
    const store = new InMemoryExecuteStore();
    store.seed(
      seedRow({
        window_from: "2025-01-01T00:00:00.000Z",
        window_to: "2025-01-02T00:00:00.000Z",
      }),
    );
    const cap = captureOutput();
    const ctx = makeContext(cap.streams, "json");
    const { producer, records } = makeRecordingProducer();
    const runner = buildReplayExecuteRunner({
      openStore: () => store.asStore(),
      source: () => makeSource([event({ occurred_at: "2025-01-01T06:00:00.000Z" })]),
      producer: () => producer,
      archiveCoverage: async () => "2024-01-01",
      now: () => NOW,
    });

    await runner({ replayJobId: "polaris_rpj_exec" }, ctx);

    expect(store.rows.get("polaris_rpj_exec")?.status).toBe("completed");
    expect(records).toHaveLength(1);
  });

  it("hands the derived plan to the source factory, so source_kind can select an adapter", async () => {
    // The wiring test. An adapter that is never given the plan is an
    // adapter that is never chosen — the plan reaching this callback is
    // the only thing that makes `source_kind` load-bearing.
    const store = new InMemoryExecuteStore();
    store.seed(
      seedRow({
        window_from: "2025-01-01T00:00:00.000Z",
        window_to: "2025-01-02T00:00:00.000Z",
      }),
    );
    const cap = captureOutput();
    const ctx = makeContext(cap.streams, "json");
    const { producer } = makeRecordingProducer();
    const kinds: string[] = [];
    const runner = buildReplayExecuteRunner({
      openStore: () => store.asStore(),
      source: (plan) => {
        kinds.push(plan.source_kind);
        return makeSource([]);
      },
      producer: () => producer,
      archiveCoverage: async () => "2024-01-01",
      now: () => NOW,
    });

    await runner({ replayJobId: "polaris_rpj_exec" }, ctx);

    expect(kinds).toEqual(["archive"]);
  });

  it("reports source_kind=stream for a window inside retention", async () => {
    const store = new InMemoryExecuteStore();
    store.seed(seedRow());
    const cap = captureOutput();
    const ctx = makeContext(cap.streams, "json");
    const { producer } = makeRecordingProducer();
    const kinds: string[] = [];
    const runner = buildReplayExecuteRunner({
      openStore: () => store.asStore(),
      source: (plan) => {
        kinds.push(plan.source_kind);
        return makeSource([]);
      },
      producer: () => producer,
      archiveCoverage: async () => "2024-01-01",
      now: () => NOW,
    });

    await runner({ replayJobId: "polaris_rpj_exec" }, ctx);

    expect(kinds).toEqual(["stream"]);
  });
});
