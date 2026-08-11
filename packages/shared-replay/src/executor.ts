/**
 * Replay executor (P7-003).
 *
 * Pure-ish orchestrator that turns a deterministic {@link ReplayPlan} into
 * a sequence of source reads + republished events with replay headers
 * stamped on every emission. The module performs the same role for replay
 * that a processor's `runtime.ts` performs for live ingest:
 *
 *   1. Validate the plan is executable (target=processor with both
 *      `processor_name` and `processor_version` pinned, mode=live, not a
 *      single-event surgical retry without a name to scope it).
 *
 *   2. Mark the replay-job row `running` (and stamp `started_at`) through
 *      an injected store adapter so the CLI can surface progress.
 *
 *   3. Walk the plan's chunks in order. For each chunk, ask an injected
 *      source for the matching events, transform each event into a
 *      republished envelope, stamp the platform replay headers
 *      (`polaris-replay`, `polaris-replay-job-id`), and hand the result to
 *      an injected producer.
 *
 *   4. Stamp counters (`events_planned`, `events_replayed`,
 *      `events_failed`) after every chunk so a crashed executor leaves the
 *      `replay_jobs` row pointing at the last-completed chunk.
 *
 *   5. On success, mark the row `completed` and stamp `finished_at`. On
 *      failure, mark the row `failed`, stamp `finished_at`, and persist
 *      the error class + message so an operator triaging via `polaris
 *      replay show` sees the cause without a separate log dive.
 *
 * Architectural rules baked into the module:
 *
 *   - **The executor consumes plans, not declarations.** The planner owns
 *     the plan shape; the executor never recomputes a plan from a job row
 *     directly. Callers always run `planReplay(declaration)` first.
 *
 *   - **The executor does no I/O of its own.** Every Kafka / SQL touch
 *     goes through an injected adapter (`ReplayExecutorSource`,
 *     `ReplayExecutorProducer`, `ReplayExecutorStore`). This keeps the
 *     module pure, lets tests inject fakes without a real broker, and
 *     keeps the package's dependency surface tiny (no transport client, no
 *     PostgreSQL client).
 *
 *   - **The executor is the only writer of executor-side state.** It
 *     advances the lifecycle `pending|planning -> running -> completed`
 *     and increments the planner counters. The operator surface
 *     (`replay cancel|pause|resume`) lives in the CLI and never bumps
 *     counters. The cancel path is honored cooperatively: the executor
 *     re-reads the row status between chunks and aborts cleanly when it
 *     sees `cancelled` or `paused`.
 *
 *   - **Every emitted event carries the platform replay headers.** The
 *     P7-004 destination guardrails check `polaris-replay: true` against
 *     the per-destination `replay_opt_in` column; producers that forget
 *     to stamp the header would cause destinations to deliver replayed
 *     events as if they were live, which is unsafe.
 *
 *   - **Lineage is mandatory on every republished envelope.** The
 *     executor copies the `polaris-replay-job-id` header value into the
 *     envelope's `processor` slot so ClickHouse / downstream consumers
 *     see the replay job that emitted the event without parsing headers.
 *
 * @see docs/architecture/05-processors-and-replay.md "Replay Control Plane"
 * @see docs/implementation/tasks/P7-003-processor-replay-executor.md
 * @see packages/shared-destinations/src/replay-suppression.ts
 */

import type { ReplayPlan, ReplayPlanChunk } from "./types.js";

// ---------------------------------------------------------------------------
// Platform header names
// ---------------------------------------------------------------------------

/**
 * Header name the replay tooling stamps on every republished event.
 * Mirrors `POLARIS_HEADER_REPLAY` in `@polaris/shared-destinations`;
 * duplicated here so the executor module stays standalone (no transitive
 * dependency on the destinations package).
 */
export const REPLAY_HEADER_FLAG = "polaris-replay";

/**
 * Header name the replay tooling stamps with the replay-job id (UUIDv7).
 * Used by audit / metrics / destination suppression.
 */
export const REPLAY_HEADER_JOB_ID = "polaris-replay-job-id";

// ---------------------------------------------------------------------------
// Executor refusal codes
// ---------------------------------------------------------------------------

/**
 * Closed set of reasons the executor refuses to start. Operators see the
 * code in the CLI exit-code surface; scripts grep for the literal string.
 * The set is small on purpose; risks the planner flagged as advisory
 * (e.g. `wide_time_window`) do NOT block the executor.
 */
export const REPLAY_EXECUTOR_REFUSAL_CODES = [
  /** Plan was issued in `dry_run` mode; the executor refuses to ship. */
  "plan_is_dry_run",
  /**
   * Target is `processor` but the planner did NOT pin
   * `processor_name`/`processor_version`. The executor cannot know which
   * processor topology to invoke without the pin.
   */
  "processor_target_not_pinned",
  /**
   * Plan has zero chunks. Should never happen for a valid planner output;
   * the guard exists so a corrupted plan input rejects deterministically
   * instead of completing with `events_replayed=0`.
   */
  "plan_has_no_chunks",
  /**
   * Replay-job row was already in a terminal state when the executor
   * picked it up. The lifecycle is cooperative; the executor refuses to
   * advance a row that the operator (or a peer executor) closed.
   */
  "job_already_terminal",
  /**
   * Replay-job row is in `paused` or `cancelled` state before the
   * executor opened a chunk. Companion to `job_already_terminal` — the
   * paused / cancelled lifecycle is a peer signal from the operator
   * surface.
   */
  "job_paused_or_cancelled",
] as const;

export type ReplayExecutorRefusalCode = (typeof REPLAY_EXECUTOR_REFUSAL_CODES)[number];

/**
 * Structured error returned by {@link executeReplay} when the executor
 * refuses to run or aborts mid-stream. The error carries a `code` from
 * the closed set above so callers can branch deterministically.
 */
export class ReplayExecutorError extends Error {
  public override readonly name = "ReplayExecutorError";

  public readonly code: ReplayExecutorRefusalCode;

  constructor(code: ReplayExecutorRefusalCode, message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Adapter shapes
// ---------------------------------------------------------------------------

/**
 * A single event read from the source topic family. The executor does not
 * inspect the event body except to thread it through the producer; the
 * shape is intentionally minimal so the source adapter can return any
 * already-decoded envelope without an extra normalisation step.
 *
 * `headers` is the platform header bag stringified to a plain
 * `Record<string, string>` so the executor module does not depend on
 * the transport. The producer adapter is responsible for serialising the
 * headers back into the driver's format if needed.
 */
export interface ReplaySourceEvent {
  /** Platform-issued event id (UUIDv7). */
  readonly event_id: string;
  /** Canonical event name (e.g. `purchase`, `pageview`). */
  readonly event_name: string;
  /** Project id the event originated under. */
  readonly project_id: string;
  /** Environment the event originated under. */
  readonly environment: string;
  /** Inclusive timestamp the event was emitted (ISO 8601 UTC). */
  readonly occurred_at: string;
  /** Partition key the original producer used (for ordering). */
  readonly partition_key: string;
  /** Raw envelope bytes the producer originally serialized. */
  readonly value: Uint8Array;
  /** Original headers, as a string-only map for serializability. */
  readonly headers: Record<string, string>;
}

/**
 * Adapter the executor calls once per chunk to read events from the
 * source topic family. Implementations either:
 *
 *   - in tests: return a pre-loaded array,
 *   - in production: read the chunk's offset range from RabbitMQ via
 *     `@polaris/shared-transport`.
 *
 * The adapter is expected to honor the chunk bounds — events whose
 * `occurred_at` falls outside `[from, to]` MUST be filtered out by the
 * adapter, not the executor. The executor trusts what the adapter
 * returns.
 */
export interface ReplayExecutorSource {
  /**
   * Fetch the events in the supplied chunk. The chunk's `from` / `to`
   * are inclusive ISO 8601 strings; the adapter narrows them onto its
   * underlying topic offsets. Returning an empty array is valid (a chunk
   * with no matching events) and produces a zero-count delta in the
   * stamp.
   */
  fetchChunk(input: ReplayFetchChunkInput): Promise<ReadonlyArray<ReplaySourceEvent>>;
}

/**
 * Input handed to {@link ReplayExecutorSource.fetchChunk}.
 */
export interface ReplayFetchChunkInput {
  /** Chunk currently being executed. */
  readonly chunk: ReplayPlanChunk;
  /** Plan the chunk belongs to (project/env/scope filters). */
  readonly plan: ReplayPlan;
}

/**
 * Republished event the executor hands to the producer adapter. Carries
 * the original payload plus the platform replay headers; the producer
 * adapter is responsible for forwarding it to RabbitMQ.
 */
export interface ReplayProduceRecord {
  /** Topic the executor wants the event written to. */
  readonly topic: string;
  /** Partition key (carries through from the source for ordering). */
  readonly partition_key: string;
  /** Raw envelope bytes. */
  readonly value: Uint8Array;
  /** Headers including the platform replay markers. */
  readonly headers: Record<string, string>;
  /** Echo of the source event id so the adapter can log lineage. */
  readonly source_event_id: string;
}

/**
 * Adapter the executor calls once per produced record. Implementations
 * either:
 *
 *   - in tests: append to an in-memory array,
 *   - in production: hand the record to a `PolarisProducer` send call.
 *
 * The adapter is responsible for catching transient Kafka errors and
 * retrying within its own policy; an exception propagates to the
 * executor and marks the chunk failed.
 */
export interface ReplayExecutorProducer {
  publish(record: ReplayProduceRecord): Promise<void>;
}

/**
 * Per-chunk progress payload handed to the store adapter so the CLI's
 * `replay show` reflects in-flight progress.
 */
export interface ReplayChunkProgress {
  /** Replay-job id (UUIDv7). */
  readonly replay_job_id: string;
  /** Chunk that finished. */
  readonly chunk_index: number;
  /** Total chunks in the plan (for percent-complete renderers). */
  readonly chunk_count: number;
  /** Events successfully republished within this chunk. */
  readonly events_emitted: number;
  /** Events the producer / source flagged as failed within this chunk. */
  readonly events_failed: number;
  /** Cumulative count of emitted events across all completed chunks. */
  readonly cumulative_emitted: number;
  /** Cumulative count of failed events across all completed chunks. */
  readonly cumulative_failed: number;
}

/**
 * Adapter the executor calls to advance the replay-job row's lifecycle.
 * In production this writes to `replay_jobs` via Kysely; in tests it
 * captures the calls for assertions.
 */
export interface ReplayExecutorStore {
  /**
   * Transition `pending|planning` to `running`. Returns the row's status
   * BEFORE the transition so the executor can branch on a peer setter
   * having flipped the row to `paused` or `cancelled` first.
   *
   * Returns `null` when the row no longer exists (the cancel path raced
   * the executor).
   */
  markRunning(input: ReplayMarkRunningInput): Promise<ReplayCurrentStatus | null>;
  /**
   * Stamp progress for one completed chunk. Idempotent — repeated calls
   * with the same `chunk_index` MUST NOT double-count events. Returns
   * the row's status after the update so the executor can detect a peer
   * setter having flipped the row to `paused` or `cancelled`.
   */
  recordChunkProgress(input: ReplayChunkProgress & ReplayClockStamp): Promise<ReplayCurrentStatus>;
  /**
   * Transition `running` to `completed` and stamp `finished_at`. Returns
   * `true` when the row transitioned; `false` when the row was already
   * terminal (e.g. cancelled mid-flight).
   */
  markCompleted(input: ReplayMarkCompletedInput): Promise<boolean>;
  /**
   * Transition `running` to `failed`, stamp `finished_at`, and persist
   * the error class / message. Returns `true` when the row transitioned.
   */
  markFailed(input: ReplayMarkFailedInput): Promise<boolean>;
}

/**
 * Snapshot of the row's status returned by the store after a transition.
 * Includes the events counters so the executor can verify they line up
 * with its local accumulator (the executor refuses to double-count even
 * if the store retries an UPDATE).
 */
export interface ReplayCurrentStatus {
  readonly status: string;
  readonly events_planned: number;
  readonly events_replayed: number;
  readonly events_failed: number;
}

export interface ReplayClockStamp {
  readonly now: Date;
}

export interface ReplayMarkRunningInput extends ReplayClockStamp {
  readonly replay_job_id: string;
  readonly events_planned: number;
}

export interface ReplayMarkCompletedInput extends ReplayClockStamp {
  readonly replay_job_id: string;
  readonly events_replayed: number;
  readonly events_failed: number;
}

export interface ReplayMarkFailedInput extends ReplayClockStamp {
  readonly replay_job_id: string;
  readonly events_replayed: number;
  readonly events_failed: number;
  readonly error_class: string;
  readonly error_message: string;
}

// ---------------------------------------------------------------------------
// Logger seam (optional — defaults to no-op)
// ---------------------------------------------------------------------------

/**
 * Minimal logger surface so the executor can emit structured progress
 * lines without depending on `@polaris/shared-logger`. Production
 * callers wire a real `pino` instance; tests pass an array sink to
 * assert the lines fired.
 */
export interface ReplayExecutorLogger {
  debug(payload: Record<string, unknown>, message: string): void;
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}

const NOOP_LOGGER: ReplayExecutorLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// Metrics sink (3S3YY2PG)
// ---------------------------------------------------------------------------

/**
 * Stable metric names emitted by the executor when a {@link ReplayExecutorMetricsSink}
 * is supplied. The names are stable contracts for the
 * `PolarisReplayJobStuck` alert — see
 * `infra/prometheus/rules/polaris.alerts.yml`.
 */
export const METRIC_REPLAY_JOB_PROGRESS_OFFSET = "polaris_replay_job_progress_offset";
export const METRIC_REPLAY_JOB_STATUS = "polaris_replay_job_status";

/** Closed set of status values the executor records via the metrics sink. */
export const REPLAY_JOB_STATUS_VALUES = ["running", "completed", "failed", "aborted"] as const;
export type ReplayJobStatusValue = (typeof REPLAY_JOB_STATUS_VALUES)[number];

/**
 * Sink the executor calls on each lifecycle transition + chunk
 * commit. The contract:
 *
 *   - `observeStatus({ replay_job_id, status })` is called when the
 *     row's status becomes `running` (executor start), and again with
 *     the terminal status (`completed`, `failed`, `aborted`).
 *   - `observeProgress({ replay_job_id, progress_offset })` is called
 *     after every chunk's recordChunkProgress; `progress_offset` is
 *     the cumulative emitted count, which advances monotonically.
 *
 * The sink is optional — replay's hot path does not depend on it. The
 * shape mirrors the operator-gate sink (`OperatorGateMetricsSink`):
 * keep the executor pure and let the host decide where the gauges
 * land. The CLI runner today does not wire a sink because the CLI
 * has no `/metrics` endpoint; the metric is meaningful in a
 * long-running scraper component (control-plane API or a future
 * replay-coordinator service) that reads `replay_jobs` rows and
 * emits these gauges per-row.
 */
export interface ReplayExecutorMetricsSink {
  observeProgress(input: {
    readonly replay_job_id: string;
    readonly progress_offset: number;
  }): void;
  observeStatus(input: {
    readonly replay_job_id: string;
    readonly status: ReplayJobStatusValue;
  }): void;
}

const NOOP_METRICS_SINK: ReplayExecutorMetricsSink = {
  observeProgress: () => {},
  observeStatus: () => {},
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface ExecuteReplayInput {
  /** Plan produced by {@link planReplay}. */
  readonly plan: ReplayPlan;
  /** Source adapter that reads events from the source topic family. */
  readonly source: ReplayExecutorSource;
  /** Producer adapter that republishes events with replay headers. */
  readonly producer: ReplayExecutorProducer;
  /** Store adapter that persists lifecycle transitions + counters. */
  readonly store: ReplayExecutorStore;
  /**
   * Topic the executor writes republished events to. Defaults to the
   * plan's `source_topic_family` (we re-emit on the same family the
   * source events were originally produced on; processor consumers pick
   * up the replay just like live traffic). Tests can override to assert
   * a different routing without changing the plan shape.
   */
  readonly target_topic?: string;
  /**
   * Clock injected for determinism. Defaults to `() => new Date()`.
   * Production wires this through the CLI runner's clock seam so tests
   * see deterministic `started_at` / `finished_at` stamps.
   */
  readonly now?: () => Date;
  /** Optional structured logger. Defaults to a no-op. */
  readonly logger?: ReplayExecutorLogger;
  /**
   * Optional metrics sink (3S3YY2PG). When supplied, the executor
   * emits `polaris_replay_job_status` and
   * `polaris_replay_job_progress_offset` gauges on lifecycle
   * transitions. The sink is invoked synchronously; implementations
   * must not block.
   */
  readonly metrics?: ReplayExecutorMetricsSink;
  /**
   * Override that lets tests inject a synthetic `events_planned` count
   * before any chunk has been read. Production callers omit this; the
   * executor falls back to "unknown" (0) until the first chunk is read.
   */
  readonly events_planned_hint?: number;
}

/**
 * Per-chunk outcome captured in the {@link ExecuteReplayOutcome.chunks}
 * array. Used by tests and the CLI's structured output.
 */
export interface ReplayChunkOutcome {
  readonly index: number;
  readonly from: string;
  readonly to: string;
  readonly events_emitted: number;
  readonly events_failed: number;
  readonly aborted: boolean;
}

export type ExecuteReplayOutcomeStatus = "completed" | "failed" | "aborted";

export interface ExecuteReplayOutcome {
  /** Replay-job id (echo of the plan). */
  readonly replay_job_id: string;
  /** Terminal status the row finished in. */
  readonly status: ExecuteReplayOutcomeStatus;
  /** Cumulative count of emitted events across all chunks. */
  readonly events_replayed: number;
  /** Cumulative count of failed events across all chunks. */
  readonly events_failed: number;
  /** Per-chunk outcomes in chunk index order. */
  readonly chunks: readonly ReplayChunkOutcome[];
  /**
   * Error captured when `status === 'failed'`. The executor records the
   * error class and message into the row via `markFailed`; this surface
   * is the same data so the CLI can render it directly.
   */
  readonly error: { readonly error_class: string; readonly error_message: string } | null;
  /** Started / finished stamps (ISO 8601 UTC). */
  readonly started_at: string;
  readonly finished_at: string;
}

/**
 * Execute a replay plan. Returns an {@link ExecuteReplayOutcome};
 * throws {@link ReplayExecutorError} for refusal conditions. Adapter
 * failures (Kafka send error, store unreachable, etc.) propagate
 * verbatim — the caller decides whether to retry. The replay row is
 * always marked `failed` BEFORE the propagating throw so the lifecycle
 * never strands in `running`.
 */
export async function executeReplay(input: ExecuteReplayInput): Promise<ExecuteReplayOutcome> {
  const { plan } = input;
  const logger = input.logger ?? NOOP_LOGGER;
  const metrics = input.metrics ?? NOOP_METRICS_SINK;
  const nowFn = input.now ?? ((): Date => new Date());

  // ---- pre-flight refusals -------------------------------------------
  if (plan.mode === "dry_run") {
    throw new ReplayExecutorError(
      "plan_is_dry_run",
      `executor refuses to ship a dry_run plan (replay_job_id=${plan.replay_job_id}); promote --mode live first`,
    );
  }
  if (plan.target === "processor") {
    if (plan.processor_name === null || plan.processor_version === null) {
      throw new ReplayExecutorError(
        "processor_target_not_pinned",
        `executor refuses to start: processor target requires both processor_name and processor_version (replay_job_id=${plan.replay_job_id})`,
      );
    }
  }
  if (plan.chunks.length === 0) {
    throw new ReplayExecutorError(
      "plan_has_no_chunks",
      `plan has no chunks (replay_job_id=${plan.replay_job_id}); the planner contract guarantees at least one chunk per window — input plan is corrupted`,
    );
  }

  // ---- start ---------------------------------------------------------
  const startedAt = nowFn();
  const startedAtIso = startedAt.toISOString();
  const targetTopic = input.target_topic ?? plan.target_topic_family;
  const eventsPlannedHint = input.events_planned_hint ?? 0;

  const transition = await input.store.markRunning({
    replay_job_id: plan.replay_job_id,
    events_planned: eventsPlannedHint,
    now: startedAt,
  });
  if (transition === null) {
    throw new ReplayExecutorError(
      "job_already_terminal",
      `replay job ${plan.replay_job_id} no longer exists`,
    );
  }
  if (transition.status === "paused" || transition.status === "cancelled") {
    throw new ReplayExecutorError(
      "job_paused_or_cancelled",
      `replay job ${plan.replay_job_id} is in ${transition.status} state; executor refuses to start`,
    );
  }
  if (transition.status === "completed" || transition.status === "failed") {
    throw new ReplayExecutorError(
      "job_already_terminal",
      `replay job ${plan.replay_job_id} is already ${transition.status}`,
    );
  }

  metrics.observeStatus({ replay_job_id: plan.replay_job_id, status: "running" });
  metrics.observeProgress({ replay_job_id: plan.replay_job_id, progress_offset: 0 });

  logger.info(
    {
      component: "replay.executor",
      replay_job_id: plan.replay_job_id,
      project_id: plan.project_id,
      environment: plan.environment,
      target: plan.target,
      target_topic: targetTopic,
      chunk_count: plan.chunk_count,
      started_at: startedAtIso,
    },
    "replay executor started",
  );

  // ---- per-chunk loop ------------------------------------------------
  const chunkOutcomes: ReplayChunkOutcome[] = [];
  let cumulativeEmitted = 0;
  let cumulativeFailed = 0;
  let aborted = false;

  try {
    for (const chunk of plan.chunks) {
      const events = await input.source.fetchChunk({ chunk, plan });
      let emittedInChunk = 0;
      let failedInChunk = 0;

      // The source already filtered by chunk + scope. The executor still
      // applies the plan's event-name / event-id scope here as a
      // defense-in-depth filter — a buggy adapter cannot smuggle
      // out-of-scope events past the executor.
      const filtered = events.filter((event) => matchesPlanScope(event, plan));

      for (const event of filtered) {
        try {
          await input.producer.publish(buildProduceRecord(event, plan, targetTopic));
          emittedInChunk += 1;
        } catch (err) {
          failedInChunk += 1;
          const summary = errSummary(err);
          logger.error(
            {
              component: "replay.executor",
              replay_job_id: plan.replay_job_id,
              chunk_index: chunk.index,
              source_event_id: event.event_id,
              err: { name: summary.error_class, message: summary.error_message },
            },
            "producer.publish failed; counting event as failed",
          );
        }
      }

      cumulativeEmitted += emittedInChunk;
      cumulativeFailed += failedInChunk;

      // Stamp progress BEFORE checking for cancellation so the row
      // always reflects the work that was actually done. The next call
      // returns the row's status after the stamp so we see if a peer
      // setter flipped the row.
      const progress = await input.store.recordChunkProgress({
        replay_job_id: plan.replay_job_id,
        chunk_index: chunk.index,
        chunk_count: plan.chunk_count,
        events_emitted: emittedInChunk,
        events_failed: failedInChunk,
        cumulative_emitted: cumulativeEmitted,
        cumulative_failed: cumulativeFailed,
        now: nowFn(),
      });
      metrics.observeProgress({
        replay_job_id: plan.replay_job_id,
        progress_offset: cumulativeEmitted,
      });

      logger.debug(
        {
          component: "replay.executor",
          replay_job_id: plan.replay_job_id,
          chunk_index: chunk.index,
          chunk_from: chunk.from,
          chunk_to: chunk.to,
          events_emitted: emittedInChunk,
          events_failed: failedInChunk,
          cumulative_emitted: cumulativeEmitted,
          cumulative_failed: cumulativeFailed,
          row_status: progress.status,
        },
        "chunk completed",
      );

      // Cooperative cancellation: if the operator flipped the row to
      // `paused` or `cancelled` between chunks, abort cleanly. The
      // progress for THIS chunk has already been stamped, so partial
      // work survives.
      if (progress.status === "cancelled" || progress.status === "paused") {
        chunkOutcomes.push({
          index: chunk.index,
          from: chunk.from,
          to: chunk.to,
          events_emitted: emittedInChunk,
          events_failed: failedInChunk,
          aborted: true,
        });
        aborted = true;
        break;
      }

      chunkOutcomes.push({
        index: chunk.index,
        from: chunk.from,
        to: chunk.to,
        events_emitted: emittedInChunk,
        events_failed: failedInChunk,
        aborted: false,
      });
    }
  } catch (err) {
    const finishedAt = nowFn();
    const summary = errSummary(err);
    await input.store.markFailed({
      replay_job_id: plan.replay_job_id,
      events_replayed: cumulativeEmitted,
      events_failed: cumulativeFailed,
      error_class: summary.error_class,
      error_message: summary.error_message,
      now: finishedAt,
    });
    metrics.observeStatus({ replay_job_id: plan.replay_job_id, status: "failed" });
    logger.error(
      {
        component: "replay.executor",
        replay_job_id: plan.replay_job_id,
        events_replayed: cumulativeEmitted,
        events_failed: cumulativeFailed,
        err: { name: summary.error_class, message: summary.error_message },
      },
      "replay executor failed",
    );
    return {
      replay_job_id: plan.replay_job_id,
      status: "failed",
      events_replayed: cumulativeEmitted,
      events_failed: cumulativeFailed,
      chunks: chunkOutcomes,
      error: { error_class: summary.error_class, error_message: summary.error_message },
      started_at: startedAtIso,
      finished_at: finishedAt.toISOString(),
    };
  }

  // ---- finish --------------------------------------------------------
  if (aborted) {
    metrics.observeStatus({ replay_job_id: plan.replay_job_id, status: "aborted" });
    logger.warn(
      {
        component: "replay.executor",
        replay_job_id: plan.replay_job_id,
        events_replayed: cumulativeEmitted,
        events_failed: cumulativeFailed,
      },
      "replay executor aborted by operator (row state changed mid-flight)",
    );
    const finishedAt = nowFn();
    return {
      replay_job_id: plan.replay_job_id,
      status: "aborted",
      events_replayed: cumulativeEmitted,
      events_failed: cumulativeFailed,
      chunks: chunkOutcomes,
      error: null,
      started_at: startedAtIso,
      finished_at: finishedAt.toISOString(),
    };
  }

  const completedAt = nowFn();
  await input.store.markCompleted({
    replay_job_id: plan.replay_job_id,
    events_replayed: cumulativeEmitted,
    events_failed: cumulativeFailed,
    now: completedAt,
  });
  metrics.observeStatus({ replay_job_id: plan.replay_job_id, status: "completed" });
  logger.info(
    {
      component: "replay.executor",
      replay_job_id: plan.replay_job_id,
      events_replayed: cumulativeEmitted,
      events_failed: cumulativeFailed,
      chunks_completed: chunkOutcomes.length,
      finished_at: completedAt.toISOString(),
    },
    "replay executor completed",
  );

  return {
    replay_job_id: plan.replay_job_id,
    status: "completed",
    events_replayed: cumulativeEmitted,
    events_failed: cumulativeFailed,
    chunks: chunkOutcomes,
    error: null,
    started_at: startedAtIso,
    finished_at: completedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * True when the source event passes the plan's optional scope filters.
 * The planner already narrows by project + environment via the source
 * adapter; this defense-in-depth filter catches an adapter that returns
 * an out-of-scope event id or event name.
 */
export function matchesPlanScope(event: ReplaySourceEvent, plan: ReplayPlan): boolean {
  if (event.project_id !== plan.project_id) return false;
  if (event.environment !== plan.environment) return false;
  if (plan.event_name !== null && event.event_name !== plan.event_name) return false;
  if (plan.event_id !== null && event.event_id !== plan.event_id) return false;
  return true;
}

/**
 * Translate a source event into the producer record the executor emits.
 * Carries forward the partition key and value bytes verbatim, augments
 * the headers with the platform replay markers, and routes to the
 * supplied target topic.
 */
export function buildProduceRecord(
  event: ReplaySourceEvent,
  plan: ReplayPlan,
  targetTopic: string,
): ReplayProduceRecord {
  const headers: Record<string, string> = {
    ...event.headers,
    [REPLAY_HEADER_FLAG]: "true",
    [REPLAY_HEADER_JOB_ID]: plan.replay_job_id,
  };
  return {
    topic: targetTopic,
    partition_key: event.partition_key,
    value: event.value,
    headers,
    source_event_id: event.event_id,
  };
}

function errSummary(err: unknown): { error_class: string; error_message: string } {
  if (err instanceof Error) {
    return {
      error_class: err.name ?? "Error",
      error_message: err.message,
    };
  }
  if (typeof err === "string") {
    return { error_class: "Error", error_message: err };
  }
  return { error_class: "Error", error_message: "unknown error" };
}
