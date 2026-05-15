/**
 * Behavioral tests for the replay executor (P7-003).
 *
 * The executor is the bridge between a planner-issued {@link ReplayPlan}
 * and Redpanda: it walks the plan's chunks, reads source events via an
 * injected adapter, stamps the platform replay headers
 * (`polaris-replay`, `polaris-replay-job-id`), republishes via an
 * injected producer, and persists lifecycle state through an injected
 * store. The tests in this file pin every behavior the task card calls
 * out:
 *
 *   refusal codes      dry_run plans, processor-not-pinned plans, empty
 *                      plans, already-terminal rows, paused/cancelled
 *                      rows all refuse with a structured code.
 *
 *   happy path         single-chunk plan -> emit headers stamped + state
 *                      transitions from running -> completed.
 *
 *   per-chunk progress multi-chunk plan -> recordChunkProgress fires
 *                      once per chunk with cumulative counters.
 *
 *   cooperative cancel store flips row to `cancelled` between chunks ->
 *                      executor aborts cleanly, leaves the row in its
 *                      operator-issued state, returns
 *                      `status: 'aborted'`.
 *
 *   produce failure    producer.publish throws -> counts as failed,
 *                      executor continues to the next event, the chunk
 *                      progress carries the failure delta.
 *
 *   fatal failure      source.fetchChunk throws -> executor marks the
 *                      row `failed`, persists error_class +
 *                      error_message, returns the outcome.
 *
 *   scope filter       defense-in-depth: out-of-scope events the
 *                      adapter incorrectly returned are filtered before
 *                      publish.
 *
 *   lineage headers    every produced record carries
 *                      `polaris-replay=true` and the replay_job_id.
 *
 * Test harness pattern mirrors `apps/polaris-cli/test/replay-plan-runner.test.ts`:
 * an in-memory store implements the {@link ReplayExecutorStore} interface,
 * a controllable source returns canned chunks, a recording producer
 * captures every publish call. No real Kafka or PostgreSQL is involved.
 *
 * @see docs/implementation/tasks/P7-003-processor-replay-executor.md
 */

import { describe, expect, it } from "vitest";

import {
  buildProduceRecord,
  type ExecuteReplayOutcome,
  executeReplay,
  matchesPlanScope,
  planReplay,
  REPLAY_HEADER_FLAG,
  REPLAY_HEADER_JOB_ID,
  type ReplayChunkProgress,
  type ReplayCurrentStatus,
  ReplayExecutorError,
  type ReplayExecutorLogger,
  type ReplayExecutorProducer,
  type ReplayExecutorSource,
  type ReplayExecutorStore,
  type ReplayJobStatusValue,
  type ReplayMarkCompletedInput,
  type ReplayMarkFailedInput,
  type ReplayMarkRunningInput,
  type ReplayPlan,
  type ReplayPlanChunk,
  type ReplayProduceRecord,
  type ReplaySourceEvent,
} from "../src/index.js";

const NOW = new Date("2026-05-12T12:00:00.000Z");
const JOB_ID = "polaris_rpj_test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a real plan via {@link planReplay} then apply overrides. Keeps
 * the test fixture deterministic without re-deriving the planner's
 * output by hand.
 */
function plan(overrides: Partial<ReplayPlan> = {}): ReplayPlan {
  const base = planReplay(
    {
      replay_job_id: JOB_ID,
      project_id: "storefront",
      environment: "development",
      target: "processor",
      mode: "live",
      window_from: "2026-05-10T00:00:00.000Z",
      window_to: "2026-05-11T00:00:00.000Z",
      processor_name: "sessionizer",
      processor_version: "v1",
    },
    { now: NOW },
  );
  return { ...base, ...overrides };
}

function event(overrides: Partial<ReplaySourceEvent> = {}): ReplaySourceEvent {
  return {
    event_id: "ev_1",
    event_name: "purchase",
    project_id: "storefront",
    environment: "development",
    occurred_at: "2026-05-10T03:00:00.000Z",
    partition_key: "storefront.development.user.42",
    value: new Uint8Array([1, 2, 3]),
    headers: { "polaris-source-id": "src_1" },
    ...overrides,
  };
}

interface FakeStoreState {
  status: string;
  events_planned: number;
  events_replayed: number;
  events_failed: number;
  started_at: Date | null;
  finished_at: Date | null;
  error_class: string | null;
  error_message: string | null;
  chunk_progress_calls: ReplayChunkProgress[];
  completed_calls: ReplayMarkCompletedInput[];
  failed_calls: ReplayMarkFailedInput[];
  running_calls: ReplayMarkRunningInput[];
  /** Pre-loaded sequence of status transitions per chunk. */
  status_after_chunk: string[];
}

interface FakeStore {
  state: FakeStoreState;
  adapter: ReplayExecutorStore;
}

function makeStore(initialStatus: string = "pending"): FakeStore {
  const state: FakeStoreState = {
    status: initialStatus,
    events_planned: 0,
    events_replayed: 0,
    events_failed: 0,
    started_at: null,
    finished_at: null,
    error_class: null,
    error_message: null,
    chunk_progress_calls: [],
    completed_calls: [],
    failed_calls: [],
    running_calls: [],
    status_after_chunk: [],
  };

  const snapshot = (): ReplayCurrentStatus => ({
    status: state.status,
    events_planned: state.events_planned,
    events_replayed: state.events_replayed,
    events_failed: state.events_failed,
  });

  const adapter: ReplayExecutorStore = {
    async markRunning(input) {
      state.running_calls.push(input);
      // mirror the SQL: only `pending`/`planning` flip to `running`.
      if (state.status === "pending" || state.status === "planning") {
        state.status = "running";
        state.events_planned = input.events_planned;
        state.started_at = input.now;
      }
      return snapshot();
    },
    async recordChunkProgress(input) {
      state.chunk_progress_calls.push(input);
      if (state.status === "running") {
        state.events_replayed = input.cumulative_emitted;
        state.events_failed = input.cumulative_failed;
      }
      // Pop a queued post-chunk status transition if one was configured.
      const overrideStatus = state.status_after_chunk.shift();
      if (overrideStatus !== undefined) {
        state.status = overrideStatus;
      }
      return snapshot();
    },
    async markCompleted(input) {
      state.completed_calls.push(input);
      if (state.status === "running") {
        state.status = "completed";
        state.events_replayed = input.events_replayed;
        state.events_failed = input.events_failed;
        state.finished_at = input.now;
        return true;
      }
      return false;
    },
    async markFailed(input) {
      state.failed_calls.push(input);
      if (state.status === "running") {
        state.status = "failed";
        state.events_replayed = input.events_replayed;
        state.events_failed = input.events_failed;
        state.error_class = input.error_class;
        state.error_message = input.error_message;
        state.finished_at = input.now;
        return true;
      }
      return false;
    },
  };

  return { state, adapter };
}

function makeNotFoundStore(): ReplayExecutorStore {
  return {
    async markRunning() {
      return null;
    },
    async recordChunkProgress() {
      return { status: "completed", events_planned: 0, events_replayed: 0, events_failed: 0 };
    },
    async markCompleted() {
      return false;
    },
    async markFailed() {
      return false;
    },
  };
}

function makeSource(perChunk: ReadonlyArray<ReadonlyArray<ReplaySourceEvent>>): {
  source: ReplayExecutorSource;
  callIndex: { value: number };
  inputs: Array<ReplayPlanChunk>;
} {
  const callIndex = { value: 0 };
  const inputs: Array<ReplayPlanChunk> = [];
  return {
    callIndex,
    inputs,
    source: {
      async fetchChunk({ chunk }) {
        inputs.push(chunk);
        const events = perChunk[callIndex.value] ?? [];
        callIndex.value += 1;
        return events;
      },
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

function makeProducer(throwOn: (record: ReplayProduceRecord) => boolean = () => false): {
  producer: ReplayExecutorProducer;
  published: ReplayProduceRecord[];
} {
  const published: ReplayProduceRecord[] = [];
  return {
    published,
    producer: {
      async publish(record) {
        if (throwOn(record)) {
          throw new Error(`simulated publish failure for ${record.source_event_id}`);
        }
        published.push(record);
      },
    },
  };
}

interface CapturedLogLine {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly payload: Record<string, unknown>;
  readonly message: string;
}

function makeLogger(): { logger: ReplayExecutorLogger; lines: CapturedLogLine[] } {
  const lines: CapturedLogLine[] = [];
  const logger: ReplayExecutorLogger = {
    debug: (payload, message) => lines.push({ level: "debug", payload, message }),
    info: (payload, message) => lines.push({ level: "info", payload, message }),
    warn: (payload, message) => lines.push({ level: "warn", payload, message }),
    error: (payload, message) => lines.push({ level: "error", payload, message }),
  };
  return { logger, lines };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeReplay — refusals", () => {
  it("refuses to ship a dry_run plan", async () => {
    const p = plan({ mode: "dry_run" });
    const store = makeStore();
    const src = makeSource([]);
    const prod = makeProducer();
    await expect(
      executeReplay({ plan: p, source: src.source, producer: prod.producer, store: store.adapter }),
    ).rejects.toMatchObject({
      name: "ReplayExecutorError",
      code: "plan_is_dry_run",
    });
    expect(store.state.running_calls).toHaveLength(0);
    expect(prod.published).toHaveLength(0);
  });

  it("refuses processor target without pinned name/version", async () => {
    const p = plan({ processor_name: null, processor_version: null });
    const store = makeStore();
    const src = makeSource([]);
    const prod = makeProducer();
    await expect(
      executeReplay({ plan: p, source: src.source, producer: prod.producer, store: store.adapter }),
    ).rejects.toMatchObject({
      code: "processor_target_not_pinned",
    });
    expect(store.state.running_calls).toHaveLength(0);
  });

  it("refuses an empty plan (zero chunks)", async () => {
    const p = plan({ chunks: [], chunk_count: 0 });
    const store = makeStore();
    const src = makeSource([]);
    const prod = makeProducer();
    await expect(
      executeReplay({ plan: p, source: src.source, producer: prod.producer, store: store.adapter }),
    ).rejects.toMatchObject({
      code: "plan_has_no_chunks",
    });
  });

  it("refuses when markRunning returns null (row deleted/missing)", async () => {
    const p = plan();
    const src = makeSource([]);
    const prod = makeProducer();
    await expect(
      executeReplay({
        plan: p,
        source: src.source,
        producer: prod.producer,
        store: makeNotFoundStore(),
      }),
    ).rejects.toMatchObject({
      code: "job_already_terminal",
    });
  });

  it("refuses when markRunning surfaces row in `paused` state", async () => {
    const p = plan();
    const store = makeStore("paused");
    const src = makeSource([]);
    const prod = makeProducer();
    await expect(
      executeReplay({ plan: p, source: src.source, producer: prod.producer, store: store.adapter }),
    ).rejects.toMatchObject({
      code: "job_paused_or_cancelled",
    });
  });

  it("refuses when markRunning surfaces row in `cancelled` state", async () => {
    const p = plan();
    const store = makeStore("cancelled");
    const src = makeSource([]);
    const prod = makeProducer();
    await expect(
      executeReplay({ plan: p, source: src.source, producer: prod.producer, store: store.adapter }),
    ).rejects.toMatchObject({
      code: "job_paused_or_cancelled",
    });
  });

  it("refuses when markRunning surfaces row already terminal", async () => {
    const p = plan();
    const store = makeStore("completed");
    const src = makeSource([]);
    const prod = makeProducer();
    await expect(
      executeReplay({ plan: p, source: src.source, producer: prod.producer, store: store.adapter }),
    ).rejects.toMatchObject({
      code: "job_already_terminal",
    });
  });
});

describe("executeReplay — happy path", () => {
  it("completes a single-chunk plan with one event", async () => {
    const p = plan();
    const evt = event();
    const store = makeStore();
    const src = makeSource([[evt]]);
    const prod = makeProducer();
    const { logger, lines } = makeLogger();

    const outcome = await executeReplay({
      plan: p,
      source: src.source,
      producer: prod.producer,
      store: store.adapter,
      now: () => NOW,
      logger,
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.replay_job_id).toBe(JOB_ID);
    expect(outcome.events_replayed).toBe(1);
    expect(outcome.events_failed).toBe(0);
    expect(outcome.chunks).toHaveLength(1);
    expect(outcome.chunks[0]?.aborted).toBe(false);
    expect(outcome.error).toBeNull();

    // Lifecycle state
    expect(store.state.running_calls).toHaveLength(1);
    expect(store.state.completed_calls).toHaveLength(1);
    expect(store.state.failed_calls).toHaveLength(0);
    expect(store.state.status).toBe("completed");

    // Producer call
    expect(prod.published).toHaveLength(1);
    const pub = prod.published[0];
    expect(pub).toBeDefined();
    if (pub === undefined) return;
    expect(pub.topic).toBe(p.source_topic_family);
    expect(pub.partition_key).toBe(evt.partition_key);
    expect(pub.headers[REPLAY_HEADER_FLAG]).toBe("true");
    expect(pub.headers[REPLAY_HEADER_JOB_ID]).toBe(JOB_ID);
    expect(pub.headers["polaris-source-id"]).toBe("src_1");

    // Logger lines fired for start + completion
    expect(lines.find((l) => l.message === "replay executor started")).toBeDefined();
    expect(lines.find((l) => l.message === "replay executor completed")).toBeDefined();
  });

  it("respects the target_topic override", async () => {
    const p = plan();
    const store = makeStore();
    const src = makeSource([[event()]]);
    const prod = makeProducer();
    await executeReplay({
      plan: p,
      source: src.source,
      producer: prod.producer,
      store: store.adapter,
      target_topic: "replay.events",
    });
    expect(prod.published[0]?.topic).toBe("replay.events");
  });
});

describe("executeReplay — chunking + progress", () => {
  it("calls recordChunkProgress once per chunk with cumulative counters", async () => {
    // 3-day window -> 3 chunks (UTC midnight boundaries).
    const p = planReplay(
      {
        replay_job_id: JOB_ID,
        project_id: "storefront",
        environment: "development",
        target: "processor",
        mode: "live",
        window_from: "2026-05-08T00:00:00.000Z",
        window_to: "2026-05-11T00:00:00.000Z",
        processor_name: "sessionizer",
        processor_version: "v1",
      },
      { now: NOW },
    );
    expect(p.chunk_count).toBe(3);

    const e1 = event({ event_id: "ev_a" });
    const e2 = event({ event_id: "ev_b" });
    const e3 = event({ event_id: "ev_c" });
    const src = makeSource([[e1, e2], [e3], []]);
    const store = makeStore();
    const prod = makeProducer();

    const outcome = await executeReplay({
      plan: p,
      source: src.source,
      producer: prod.producer,
      store: store.adapter,
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.events_replayed).toBe(3);
    expect(store.state.chunk_progress_calls).toHaveLength(3);

    const calls = store.state.chunk_progress_calls;
    expect(calls[0]?.events_emitted).toBe(2);
    expect(calls[0]?.cumulative_emitted).toBe(2);
    expect(calls[1]?.events_emitted).toBe(1);
    expect(calls[1]?.cumulative_emitted).toBe(3);
    expect(calls[2]?.events_emitted).toBe(0);
    expect(calls[2]?.cumulative_emitted).toBe(3);
  });

  it("aborts cleanly when the operator flips the row to `cancelled` mid-flight", async () => {
    const p = planReplay(
      {
        replay_job_id: JOB_ID,
        project_id: "storefront",
        environment: "development",
        target: "processor",
        mode: "live",
        window_from: "2026-05-08T00:00:00.000Z",
        window_to: "2026-05-11T00:00:00.000Z",
        processor_name: "sessionizer",
        processor_version: "v1",
      },
      { now: NOW },
    );
    const e1 = event({ event_id: "ev_a" });
    const e2 = event({ event_id: "ev_b" });
    const src = makeSource([[e1], [e2], []]);
    const store = makeStore();
    // After the FIRST chunk's recordChunkProgress, flip the row to cancelled.
    store.state.status_after_chunk.push("cancelled");
    const prod = makeProducer();

    const outcome = await executeReplay({
      plan: p,
      source: src.source,
      producer: prod.producer,
      store: store.adapter,
    });

    expect(outcome.status).toBe("aborted");
    expect(outcome.events_replayed).toBe(1);
    expect(outcome.chunks).toHaveLength(1);
    expect(outcome.chunks[0]?.aborted).toBe(true);
    // The remaining chunks were NOT consumed.
    expect(src.callIndex.value).toBe(1);
    // markCompleted / markFailed were NOT called.
    expect(store.state.completed_calls).toHaveLength(0);
    expect(store.state.failed_calls).toHaveLength(0);
  });

  it("aborts cleanly when the operator flips the row to `paused`", async () => {
    const p = planReplay(
      {
        replay_job_id: JOB_ID,
        project_id: "storefront",
        environment: "development",
        target: "processor",
        mode: "live",
        window_from: "2026-05-08T00:00:00.000Z",
        window_to: "2026-05-11T00:00:00.000Z",
        processor_name: "sessionizer",
        processor_version: "v1",
      },
      { now: NOW },
    );
    const src = makeSource([[event({ event_id: "ev_a" })], [event({ event_id: "ev_b" })], []]);
    const store = makeStore();
    store.state.status_after_chunk.push("paused");
    const prod = makeProducer();

    const outcome = await executeReplay({
      plan: p,
      source: src.source,
      producer: prod.producer,
      store: store.adapter,
    });

    expect(outcome.status).toBe("aborted");
    expect(outcome.events_replayed).toBe(1);
    expect(src.callIndex.value).toBe(1);
  });
});

describe("executeReplay — failure paths", () => {
  it("counts a producer.publish failure as a failed event and continues", async () => {
    const p = plan();
    const e1 = event({ event_id: "ev_a" });
    const e2 = event({ event_id: "ev_b" });
    const src = makeSource([[e1, e2]]);
    const store = makeStore();
    // Fail the SECOND publish only.
    const prod = makeProducer((rec) => rec.source_event_id === "ev_b");

    const outcome = await executeReplay({
      plan: p,
      source: src.source,
      producer: prod.producer,
      store: store.adapter,
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.events_replayed).toBe(1);
    expect(outcome.events_failed).toBe(1);
    expect(prod.published).toHaveLength(1);
    expect(store.state.chunk_progress_calls[0]?.events_failed).toBe(1);
  });

  it("marks the row failed when source.fetchChunk throws", async () => {
    const p = plan();
    const src = makeFailingSource(new TypeError("kafka unreachable"));
    const store = makeStore();
    const prod = makeProducer();

    const outcome = await executeReplay({
      plan: p,
      source: src,
      producer: prod.producer,
      store: store.adapter,
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.error?.error_class).toBe("TypeError");
    expect(outcome.error?.error_message).toBe("kafka unreachable");
    expect(store.state.failed_calls).toHaveLength(1);
    expect(store.state.status).toBe("failed");
    expect(store.state.error_class).toBe("TypeError");
    expect(store.state.error_message).toBe("kafka unreachable");
  });

  it("non-Error throws still produce a `failed` outcome", async () => {
    const p = plan();
    const src: ReplayExecutorSource = {
      async fetchChunk() {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "raw string panic";
      },
    };
    const store = makeStore();
    const prod = makeProducer();

    const outcome = await executeReplay({
      plan: p,
      source: src,
      producer: prod.producer,
      store: store.adapter,
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.error?.error_class).toBe("Error");
    expect(outcome.error?.error_message).toBe("raw string panic");
  });
});

describe("executeReplay — scope defense in depth", () => {
  it("drops events the source returned outside the plan's project/environment", async () => {
    const p = plan();
    const inScope = event({ event_id: "ev_a" });
    const wrongProject = event({ event_id: "ev_b", project_id: "other" });
    const wrongEnv = event({ event_id: "ev_c", environment: "staging" });
    const src = makeSource([[inScope, wrongProject, wrongEnv]]);
    const store = makeStore();
    const prod = makeProducer();

    const outcome = await executeReplay({
      plan: p,
      source: src.source,
      producer: prod.producer,
      store: store.adapter,
    });
    expect(outcome.events_replayed).toBe(1);
    expect(prod.published).toHaveLength(1);
    expect(prod.published[0]?.source_event_id).toBe("ev_a");
  });

  it("drops events whose event_name does not match the plan's event_name filter", async () => {
    const p = plan({ event_name: "purchase" });
    const ok = event({ event_id: "ev_a", event_name: "purchase" });
    const bad = event({ event_id: "ev_b", event_name: "pageview" });
    const src = makeSource([[ok, bad]]);
    const store = makeStore();
    const prod = makeProducer();

    const outcome = await executeReplay({
      plan: p,
      source: src.source,
      producer: prod.producer,
      store: store.adapter,
    });
    expect(outcome.events_replayed).toBe(1);
    expect(prod.published[0]?.source_event_id).toBe("ev_a");
  });
});

describe("buildProduceRecord", () => {
  it("stamps the platform replay headers and preserves the original headers", () => {
    const p = plan();
    const evt = event({
      headers: { "polaris-event-id": "ev_a", "x-custom": "kept" },
    });
    const rec = buildProduceRecord(evt, p, p.source_topic_family);
    expect(rec.headers[REPLAY_HEADER_FLAG]).toBe("true");
    expect(rec.headers[REPLAY_HEADER_JOB_ID]).toBe(JOB_ID);
    expect(rec.headers["polaris-event-id"]).toBe("ev_a");
    expect(rec.headers["x-custom"]).toBe("kept");
  });
});

describe("matchesPlanScope", () => {
  it("rejects an event from another project_id", () => {
    const p = plan();
    expect(matchesPlanScope(event({ project_id: "other" }), p)).toBe(false);
  });
  it("rejects an event from another environment", () => {
    const p = plan();
    expect(matchesPlanScope(event({ environment: "production" }), p)).toBe(false);
  });
  it("accepts when scope filters are null", () => {
    const p = plan({ event_name: null, event_id: null });
    expect(matchesPlanScope(event(), p)).toBe(true);
  });
  it("applies the event_id filter when set", () => {
    const p = plan({ event_id: "ev_x" });
    expect(matchesPlanScope(event({ event_id: "ev_a" }), p)).toBe(false);
    expect(matchesPlanScope(event({ event_id: "ev_x" }), p)).toBe(true);
  });
});

describe("ReplayExecutorError", () => {
  it("carries the closed-set code", () => {
    const err = new ReplayExecutorError("plan_is_dry_run", "test");
    expect(err.code).toBe("plan_is_dry_run");
    expect(err.name).toBe("ReplayExecutorError");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("executeReplay — metrics sink (3S3YY2PG)", () => {
  it("emits status and progress observations on the happy path", async () => {
    const p = plan();
    const src = makeSource([
      [event({ event_id: "ev_a" })],
      [event({ event_id: "ev_b" })],
      [event({ event_id: "ev_c" })],
      [event({ event_id: "ev_d" })],
      [event({ event_id: "ev_e" })],
      [event({ event_id: "ev_f" })],
      [event({ event_id: "ev_g" })],
    ]);
    const prod = makeProducer();
    const store = makeStore();

    const statuses: Array<{ replay_job_id: string; status: string }> = [];
    const progresses: Array<{ replay_job_id: string; progress_offset: number }> = [];
    const metrics = {
      observeStatus: (input: { replay_job_id: string; status: ReplayJobStatusValue }) => {
        statuses.push(input);
      },
      observeProgress: (input: { replay_job_id: string; progress_offset: number }) => {
        progresses.push(input);
      },
    };

    await executeReplay({
      plan: p,
      source: src.source,
      producer: prod.producer,
      store: store.adapter,
      metrics,
      now: () => NOW,
    });

    // First and last status observations: `running` then `completed`.
    expect(statuses[0]).toEqual({ replay_job_id: JOB_ID, status: "running" });
    expect(statuses.at(-1)).toEqual({ replay_job_id: JOB_ID, status: "completed" });
    // Initial progress is 0; final cumulative_emitted is monotonically
    // non-decreasing across observations.
    expect(progresses[0]).toEqual({ replay_job_id: JOB_ID, progress_offset: 0 });
    const offsets = progresses.map((o) => o.progress_offset);
    for (let i = 1; i < offsets.length; i += 1) {
      expect(offsets[i]).toBeGreaterThanOrEqual(offsets[i - 1] ?? 0);
    }
  });

  it("emits `failed` status when an adapter throws", async () => {
    const p = plan();
    const src: ReplayExecutorSource = {
      async fetchChunk() {
        throw new Error("broker down");
      },
    };
    const prod = makeProducer();
    const store = makeStore();
    const statuses: Array<{ replay_job_id: string; status: string }> = [];
    const metrics = {
      observeStatus: (input: { replay_job_id: string; status: ReplayJobStatusValue }) => {
        statuses.push(input);
      },
      observeProgress: () => {},
    };

    await executeReplay({
      plan: p,
      source: src,
      producer: prod.producer,
      store: store.adapter,
      metrics,
      now: () => NOW,
    });

    expect(statuses[0]?.status).toBe("running");
    expect(statuses.at(-1)?.status).toBe("failed");
  });
});

// Compile-time witness: the ExecuteReplayOutcome shape is exported.
export type _Witness = ExecuteReplayOutcome["chunks"][number];
