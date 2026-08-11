/**
 * Public types for the Polaris replay planner.
 *
 * The planner is a pure-function module that turns an operator-issued
 * replay-job declaration into a deterministic, side-effect-free **plan**.
 * Every consumer in the replay control plane reads the plan from this
 * package rather than re-deriving it from the job row:
 *
 *   - the `polaris replay plan` dry-run command (P7-002) renders the plan
 *     as human / JSON output
 *   - the processor replay executor (P7-003) consumes the plan to issue
 *     real Kafka reads and writes
 *   - the destination replay guardrails (P7-004) consult the plan to
 *     decide whether sends are suppressed
 *   - the ClickHouse rebuild workflows (P7-005) consume the analytics-raw
 *     branch of the plan
 *
 * Architectural rule baked into this module:
 *
 *   The planner OWNS the plan. PostgreSQL stores ONLY the job declaration
 *   (project, environment, target, mode, time window, reason). The plan
 *   itself is recomputed from the declaration each time it is needed.
 *   Versioned semantic outputs (partition strategy, chunking rules,
 *   destination policy, risk flags, consumer-group naming) live here in
 *   code, not in the migration.
 *
 * @see docs/architecture/05-processors-and-replay.md "Replay Control Plane"
 * @see docs/architecture/03-rabbitmq-streams.md "Default Canonical Topics"
 * @see docs/implementation/tasks/P7-002-replay-planner-dry-run.md
 */

/**
 * Subsystems that a replay job can target. Mirrors the closed set the CLI
 * accepts for `--target` (see `apps/polaris-cli/src/db/replay-jobs.ts` —
 * `REPLAY_JOB_TARGETS`). Listed here so the planner stays standalone and
 * its tests do not depend on the CLI's typed surface.
 */
export const REPLAY_PLAN_TARGETS = ["analytics_raw", "destinations", "processor"] as const;
export type ReplayPlanTarget = (typeof REPLAY_PLAN_TARGETS)[number];

/**
 * Replay dispatch modes accepted by the planner. `dry_run` produces a
 * plan and counts only (no traffic emitted); `live` is the actual
 * re-emission. The CLI default for `--mode` is `dry_run` so a typo'd
 * `polaris replay create` never ships data.
 */
export const REPLAY_PLAN_MODES = ["dry_run", "live"] as const;
export type ReplayPlanMode = (typeof REPLAY_PLAN_MODES)[number];

/**
 * Environments the planner recognises. Only `production` triggers the
 * stricter scope checks (cannot be unscoped — `project_id` is required).
 */
export const REPLAY_PLAN_ENVIRONMENTS = ["development", "staging", "production"] as const;
export type ReplayPlanEnvironment = (typeof REPLAY_PLAN_ENVIRONMENTS)[number];

/**
 * Closed-set risk flags emitted by the planner. Each flag carries a
 * structured code so dry-run consumers can render the same string on the
 * CLI and in a future admin UI. The narrative copy on a flag is stable
 * but not load-bearing — scripts should branch on `code`.
 */
export const REPLAY_RISK_CODES = [
  /**
   * Replay window is wider than 7 days. Heads-up that the job will
   * stream a large number of partitions; not blocking.
   */
  "wide_time_window",
  /**
   * Target is `destinations` AND opt-in is on. External sends will
   * happen. Operators should double-check the project's destination
   * inventory before approving.
   */
  "destination_sends_enabled",
  /**
   * Target is `processor` but `processor_name` / `processor_version`
   * were not supplied at plan time. The dry-run still renders, but the
   * executor will refuse to start until they are pinned by the
   * job declaration.
   */
  "processor_target_not_pinned",
  /**
   * The replay scope is restricted to a single `event_id`. Useful as a
   * surgical retry, but unusual enough that it is surfaced for review.
   */
  "single_event_replay",
  /**
   * Environment is `production`. Not blocking — production replays are
   * a legitimate operation — but every production replay should land
   * behind an approval gate in the executor.
   */
  "production_scope",
] as const;
export type ReplayRiskCode = (typeof REPLAY_RISK_CODES)[number];

/**
 * Closed-set reason codes for planner rejections. The CLI returns these
 * verbatim in the error message so scripts can grep for them.
 */
export const REPLAY_PLAN_REJECTION_CODES = [
  /** `project_id` missing or empty (always required by the planner). */
  "missing_project_id",
  /** `environment` missing or outside the allowed set. */
  "invalid_environment",
  /** `target` missing or outside the allowed set. */
  "invalid_target",
  /** `mode` missing or outside the allowed set. */
  "invalid_mode",
  /** `window_from` is not a valid `Date`. */
  "invalid_window_from",
  /** `window_to` is not a valid `Date`. */
  "invalid_window_to",
  /** `window_to` precedes `window_from`. */
  "window_inverted",
  /** `window_from` is older than the operational retention window. */
  "outside_retention_window",
  /** `window_to` is later than the planner's `now` clock. */
  "window_in_future",
  /** Production replay was issued without `project_id` scope. */
  "production_replay_unscoped",
  /** `destinations_enabled=true` without an opt-in note. */
  "destination_opt_in_requires_note",
] as const;
export type ReplayPlanRejectionCode = (typeof REPLAY_PLAN_REJECTION_CODES)[number];

/**
 * Operator-issued replay-job declaration. This is the input to the
 * planner. It mirrors the `replay_jobs` row (minus the lifecycle
 * timestamps and counters); the planner consumes a JS object, not a
 * database row, so a future control-plane API or test fixture can build
 * one without going through PostgreSQL.
 *
 * Fields are all readonly; the planner refuses to mutate the input.
 */
export interface ReplayJobDeclaration {
  /** Public id of the job, e.g. `polaris_rpj_<uuidv7>`. */
  readonly replay_job_id: string;
  /** Project scope. Required. */
  readonly project_id: string;
  /** Environment scope. Required. */
  readonly environment: string;
  /** Subsystem to replay into. Required. */
  readonly target: string;
  /** Dispatch mode. Optional; defaults to `dry_run` in the planner. */
  readonly mode?: string | undefined;
  /** Inclusive window start (UTC). */
  readonly window_from: Date | string;
  /** Inclusive window end (UTC). */
  readonly window_to: Date | string;
  /**
   * Optional canonical event-name restriction. Narrows the plan to one
   * event family within the source topic.
   */
  readonly event_name?: string | null | undefined;
  /**
   * Optional single-event restriction. Combined with `event_name` for
   * surgical retries; setting it without `event_name` is permitted but
   * raises a `single_event_replay` risk flag.
   */
  readonly event_id?: string | null | undefined;
  /**
   * Pinned processor name for `target === 'processor'`. The CLI's
   * P7-001 job-row schema does not store this (planner-semantic) but the
   * planner accepts it as a separately-supplied hint so dry-run can
   * surface the future executor's full target. When omitted, the plan
   * carries `processor_target_not_pinned` risk.
   */
  readonly processor_name?: string | undefined;
  /** Pinned processor semantic version, e.g. `v2`. */
  readonly processor_version?: string | undefined;
  /**
   * Whether external destination delivery should happen during a
   * `destinations`-target replay. Defaults to FALSE — the architecture
   * mandates destination sends are disabled by default. Flipping to
   * TRUE requires `destination_opt_in_note` to be set; the planner
   * refuses the declaration otherwise.
   */
  readonly destinations_enabled?: boolean | undefined;
  /**
   * Free-form rationale for opting into destination delivery during a
   * replay. Captured in the plan and surfaced in dry-run output.
   */
  readonly destination_opt_in_note?: string | undefined;
}

/**
 * Options accepted by {@link planReplay}.
 */
export interface PlanReplayOptions {
  /**
   * Current wall-clock time. Used to:
   *
   *   - validate `window_from` is inside the operational retention window
   *   - validate `window_to` is not in the future
   *   - stamp `planned_at` on the resulting plan
   *
   * Defaults to `new Date()` if omitted. Tests pin this to a fixed
   * timestamp for determinism.
   */
  readonly now?: Date;
  /**
   * Operational retention window in days. Polaris does not promise
   * replay beyond the operational retention of the source topic
   * (RabbitMQ `raw.events` ships with 90 days by default — see
   * docs/architecture/05-processors-and-replay.md "Replay Window").
   * Defaults to 90.
   */
  readonly retentionDays?: number;
}

/**
 * One contiguous time chunk inside the planned replay window. The
 * planner splits the operator-supplied window into 1-day chunks; the
 * executor walks the chunks in order and stamps progress per chunk so
 * resume after pause is precise.
 *
 * Chunks are inclusive on both ends. Successive chunks are adjacent in
 * time (no gaps) and never overlap.
 */
export interface ReplayPlanChunk {
  /** Chunk ordinal within the plan, starting at 0. */
  readonly index: number;
  /** Inclusive chunk start (ISO 8601 UTC). */
  readonly from: string;
  /** Inclusive chunk end (ISO 8601 UTC). */
  readonly to: string;
}

/**
 * A risk note attached to a plan. The planner emits one per fired risk
 * code; consumers may render or suppress them by `code`.
 */
export interface ReplayPlanRisk {
  /** Closed-set risk code. */
  readonly code: ReplayRiskCode;
  /** Stable narrative line for human renderers. */
  readonly message: string;
}

/**
 * The shape of a deterministic replay plan returned by {@link planReplay}.
 * Carries everything dry-run output needs:
 *
 *   - source topic family + partition-key strategy
 *   - project / environment scope
 *   - time window + chunked subdivisions
 *   - target processor / consumer / version (when supplied)
 *   - destination behavior (disabled by default)
 *   - risk flags
 *   - planned consumer group
 *
 * `events_estimated` is intentionally `null` in v1 — the planner does
 * not connect to RabbitMQ to count offsets. The dry-run output prints
 * `events_estimated: unknown` rather than fabricating a number; an
 * incremental future task can wire in a real estimator without changing
 * any downstream consumer.
 */
export interface ReplayPlan {
  /** Echo of the input replay-job id so consumers do not have to thread it. */
  readonly replay_job_id: string;
  /** Project scope. */
  readonly project_id: string;
  /** Environment scope. */
  readonly environment: ReplayPlanEnvironment;
  /** Subsystem to replay into. */
  readonly target: ReplayPlanTarget;
  /** Effective dispatch mode (planner-normalised). */
  readonly mode: ReplayPlanMode;
  /** Effective event-name scope, or `null` if unrestricted. */
  readonly event_name: string | null;
  /** Effective event-id scope, or `null` if unrestricted. */
  readonly event_id: string | null;
  /**
   * Canonical RabbitMQ topic family the planner reads from. Always
   * `raw.events` in v1 (derived families are replayed via processor
   * targets, which re-read raw.events anyway).
   */
  readonly source_topic_family: string;
  /**
   * Partition-key strategy used by the executor. v1 always uses
   * `project_environment_identity` — the same strategy raw.events
   * producers use, so the executor preserves per-identity ordering.
   */
  readonly partition_key_strategy: "project_environment_identity";
  /** Inclusive window start (ISO 8601 UTC). */
  readonly window_from: string;
  /** Inclusive window end (ISO 8601 UTC). */
  readonly window_to: string;
  /** Chunked subdivision of the window. */
  readonly chunks: readonly ReplayPlanChunk[];
  /** Total chunk count. Equal to `chunks.length` — duplicated for json renderers. */
  readonly chunk_count: number;
  /** Chunk size in days. Equal across all chunks except possibly the last. */
  readonly chunk_size_days: number;
  /** Processor name when `target === 'processor'` and the operator pinned it. */
  readonly processor_name: string | null;
  /** Processor semantic version when pinned. */
  readonly processor_version: string | null;
  /**
   * Topic family the executor will publish to unless overridden.
   *
   * Distinct from `source_topic_family`, which is where events are read
   * from. They happen to be equal in v1, but conflating them is what let a
   * replay reach vendors unnoticed: reachability is a property of where
   * events are *written*.
   */
  readonly target_topic_family: string;
  /**
   * Whether this plan's publish topic can result in vendor delivery.
   *
   * Derived from `target_topic_family`, not from `target`. True for
   * `raw.events` and `analytics.events` — see `destinations.ts`.
   */
  readonly reaches_destinations: boolean;
  /** Whether the operator opted in to external destination delivery. */
  readonly destinations_enabled: boolean;
  /** Opt-in rationale when `destinations_enabled === true`. */
  readonly destination_opt_in_note: string | null;
  /**
   * Consumer group the executor will join. The shape is stable so
   * operators can grep for it in RabbitMQ. v1 format:
   *
   *   polaris-replay.<project_id>.<environment>.<target>.<replay_job_id>
   *
   * The job-id suffix guarantees no two replays share a group, so a
   * pause or cancel cannot accidentally affect another in-flight replay.
   */
  readonly consumer_group: string;
  /**
   * Estimated event count for the window. `null` in v1 because the
   * planner does not consult RabbitMQ. The CLI renders `unknown` for
   * `null`; the JSON renderer surfaces `null` verbatim.
   */
  readonly events_estimated: number | null;
  /** Risk flags (deduped, ordered by the closed-set declaration order). */
  readonly risks: readonly ReplayPlanRisk[];
  /** Planner clock stamp at the time the plan was computed (ISO 8601 UTC). */
  readonly planned_at: string;
  /**
   * Stable code stamped on every plan so consumers can branch on the
   * planner contract version. Bumps when the plan shape changes.
   */
  readonly planner_version: "v1";
}

/**
 * Structured error returned by {@link planReplay} for invalid inputs.
 * Carries a closed-set `code` so callers can branch deterministically.
 * The CLI uppercases `code` into its exit-code mapping; programmatic
 * callers (the executor, the future admin API) inspect `code` directly.
 */
export class ReplayPlanError extends Error {
  public override readonly name = "ReplayPlanError";

  public readonly code: ReplayPlanRejectionCode;

  constructor(code: ReplayPlanRejectionCode, message: string) {
    super(message);
    this.code = code;
  }
}
