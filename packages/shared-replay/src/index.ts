/**
 * `@polaris/shared-replay` — replay planner.
 *
 * Pure-function module that turns an operator-issued replay-job
 * declaration into a deterministic plan. Consumed by:
 *
 *   - `polaris replay plan` (P7-002) — dry-run renderer
 *   - the processor replay executor (P7-003)
 *   - the destination replay guardrails (P7-004)
 *   - the ClickHouse rebuild workflows (P7-005)
 *
 * The package has no I/O surface; it is safe to import from any other
 * package without pulling in PostgreSQL or Kafka dependencies.
 *
 * Architectural rule:
 *
 *   The planner OWNS the plan. PostgreSQL stores only the declaration
 *   (project, environment, target, mode, time window, reason); the plan
 *   is recomputed from the declaration each time it is needed. To
 *   change planner behavior, bump `planner_version` and ship a new
 *   release of this package.
 *
 * @see docs/architecture/05-processors-and-replay.md "Replay Control Plane"
 * @see docs/implementation/tasks/P7-002-replay-planner-dry-run.md
 */

export type {
  ExecuteReplayInput,
  ExecuteReplayOutcome,
  ExecuteReplayOutcomeStatus,
  ReplayChunkOutcome,
  ReplayChunkProgress,
  ReplayClockStamp,
  ReplayCurrentStatus,
  ReplayExecutorLogger,
  ReplayExecutorMetricsSink,
  ReplayExecutorProducer,
  ReplayExecutorRefusalCode,
  ReplayExecutorSource,
  ReplayExecutorStore,
  ReplayFetchChunkInput,
  ReplayJobStatusValue,
  ReplayMarkCompletedInput,
  ReplayMarkFailedInput,
  ReplayMarkRunningInput,
  ReplayProduceRecord,
  ReplaySourceEvent,
} from "./executor.js";
export {
  buildProduceRecord,
  executeReplay,
  METRIC_REPLAY_JOB_PROGRESS_OFFSET,
  METRIC_REPLAY_JOB_STATUS,
  matchesPlanScope,
  REPLAY_EXECUTOR_REFUSAL_CODES,
  REPLAY_HEADER_FLAG,
  REPLAY_HEADER_JOB_ID,
  REPLAY_JOB_STATUS_VALUES,
  ReplayExecutorError,
} from "./executor.js";

export {
  buildConsumerGroup,
  chunkWindow,
  DEFAULT_CHUNK_SIZE_DAYS,
  DEFAULT_RETENTION_DAYS,
  planReplay,
  WIDE_WINDOW_DAYS_THRESHOLD,
} from "./planner.js";

export { renderPlanHuman } from "./render.js";
export type {
  PlanReplayOptions,
  ReplayJobDeclaration,
  ReplayPlan,
  ReplayPlanChunk,
  ReplayPlanEnvironment,
  ReplayPlanMode,
  ReplayPlanRejectionCode,
  ReplayPlanRisk,
  ReplayPlanTarget,
  ReplayRiskCode,
} from "./types.js";
export {
  REPLAY_PLAN_ENVIRONMENTS,
  REPLAY_PLAN_MODES,
  REPLAY_PLAN_REJECTION_CODES,
  REPLAY_PLAN_TARGETS,
  REPLAY_RISK_CODES,
  ReplayPlanError,
} from "./types.js";
