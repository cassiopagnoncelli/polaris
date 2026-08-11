/**
 * Pure planner for Polaris replay jobs.
 *
 * Given a {@link ReplayJobDeclaration} (the operator's intent, normally
 * read from a `replay_jobs` row), {@link planReplay} returns a
 * deterministic {@link ReplayPlan} describing exactly what a replay
 * would do — source topic family, partition strategy, window chunking,
 * target processor / consumer / version, destination policy, planned
 * consumer group, and risk flags.
 *
 * **The planner does no I/O.** It does not connect to RabbitMQ, it does
 * not read PostgreSQL, and it does not consult `process.env`. Everything
 * that affects the output is in the declaration plus the `now` /
 * `retentionDays` options. This makes the dry-run output reproducible
 * and the same plan callable from the future executor (P7-003).
 *
 * Validation is strict-by-default. The planner refuses:
 *
 *   - any environment outside {@link REPLAY_PLAN_ENVIRONMENTS}
 *   - any target outside {@link REPLAY_PLAN_TARGETS}
 *   - any mode outside {@link REPLAY_PLAN_MODES} (with `undefined` mapped
 *     to `dry_run` first)
 *   - missing `project_id` (always — replay scope is mandatory)
 *   - production replays without `project_id` (defense in depth — a
 *     hypothetical future caller that forgets the project-id rule is
 *     rejected with the `production_replay_unscoped` code rather than
 *     silently scoped to every project in production)
 *   - inverted windows, future windows, or windows older than the
 *     retention window
 *   - destination opt-in without a written note
 *
 * Risk flags are advisory rather than blocking; the executor decides
 * whether to enforce them.
 *
 * @see types.ts for the input / output shapes
 * @see docs/architecture/05-processors-and-replay.md "Replay Control Plane"
 */
import { topicFamilyReachesDestinations } from "./destinations.js";
import {
  type PlanReplayOptions,
  REPLAY_PLAN_ENVIRONMENTS,
  REPLAY_PLAN_MODES,
  REPLAY_PLAN_TARGETS,
  type ReplayJobDeclaration,
  type ReplayPlan,
  type ReplayPlanChunk,
  type ReplayPlanEnvironment,
  ReplayPlanError,
  type ReplayPlanMode,
  type ReplayPlanRejectionCode,
  type ReplayPlanRisk,
  type ReplayPlanTarget,
  type ReplayRiskCode,
} from "./types.js";

/**
 * Default operational retention window. Matches the
 * `apps/polaris-cli/src/commands/replay/validation.ts` constant —
 * duplicated here so the planner stays standalone and its tests do not
 * import the CLI's typed surface. If the CLI's retention constant ever
 * moves (e.g. into a shared config) both call-sites must update; the
 * round-trip test in `apps/polaris-cli/test/replay-commands.test.ts`
 * asserts the contract.
 */
export const DEFAULT_RETENTION_DAYS = 90;

/**
 * Default chunk size used to subdivide the replay window. 1 day balances
 * resume granularity (pause + resume restarts at most one day of work)
 * against operational ceremony (no executor wants to iterate a million
 * sub-second chunks). The constant lives here so tests assert the
 * default without re-deriving it.
 */
export const DEFAULT_CHUNK_SIZE_DAYS = 1;

/**
 * Maximum window width (days) before the planner emits a
 * `wide_time_window` risk. Tuned to the v1 retention (90 days): a 7-day
 * window comfortably fits any single-incident replay; anything wider is
 * a heads-up for review.
 */
export const WIDE_WINDOW_DAYS_THRESHOLD = 7;

/**
 * The family v1 reads from and republishes to. Derived families are replayed
 * via processor targets, which re-read raw.events anyway.
 */
const SOURCE_TOPIC_FAMILY = "raw.events" as const;

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Plan a replay. Returns a deterministic {@link ReplayPlan}; throws
 * {@link ReplayPlanError} for invalid inputs.
 *
 * The planner clones the declaration's primitive fields into the output
 * — it never holds a reference to the declaration so a caller cannot
 * mutate the plan by mutating the source row.
 */
export function planReplay(
  declaration: ReplayJobDeclaration,
  options: PlanReplayOptions = {},
): ReplayPlan {
  const now = options.now ?? new Date();
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;

  // ---- declaration normalisation ------------------------------------
  const projectId = requireNonEmpty(
    declaration.project_id,
    "missing_project_id",
    "replay declaration is missing project_id",
  );
  const environment = normaliseEnvironment(declaration.environment);
  const target = normaliseTarget(declaration.target);
  const mode = normaliseMode(declaration.mode);

  // ---- production guard ---------------------------------------------
  // Production replays MUST be project-scoped. The planner verifies this
  // even though `project_id` is already required above — defence in
  // depth against a future caller bypassing the project check.
  if (environment === "production" && projectId.length === 0) {
    throw new ReplayPlanError(
      "production_replay_unscoped",
      "replay scope is invalid: production replays require an explicit project_id",
    );
  }

  // ---- window bounds -------------------------------------------------
  const windowFrom = parseDate(declaration.window_from, "invalid_window_from", "window_from");
  const windowTo = parseDate(declaration.window_to, "invalid_window_to", "window_to");
  if (windowTo.getTime() < windowFrom.getTime()) {
    throw new ReplayPlanError(
      "window_inverted",
      `replay window is inverted: window_to (${windowTo.toISOString()}) precedes window_from (${windowFrom.toISOString()})`,
    );
  }
  if (windowTo.getTime() > now.getTime()) {
    throw new ReplayPlanError(
      "window_in_future",
      `replay window_to (${windowTo.toISOString()}) is in the future (now=${now.toISOString()})`,
    );
  }
  const earliest = new Date(now.getTime() - retentionDays * MILLIS_PER_DAY);
  if (windowFrom.getTime() < earliest.getTime()) {
    throw new ReplayPlanError(
      "outside_retention_window",
      `replay window_from (${windowFrom.toISOString()}) is older than the ${retentionDays}-day operational retention window (earliest=${earliest.toISOString()})`,
    );
  }

  // ---- destination opt-in -------------------------------------------
  // Reachability is a property of the topic the executor PUBLISHES to, not
  // of the operator's stated target: every target republishes to raw.events,
  // which flows to the destination consumers. Enforcement lives downstream
  // (P7-004 suppression, see destinations.ts) — what is computed here is the
  // plan's honesty about blast radius.
  const targetTopicFamily = SOURCE_TOPIC_FAMILY;
  const reachesDestinations = topicFamilyReachesDestinations(targetTopicFamily);

  const destinationsEnabled = Boolean(declaration.destinations_enabled);
  const destinationOptInNote = trimToNull(declaration.destination_opt_in_note);

  if (destinationsEnabled && destinationOptInNote === null) {
    throw new ReplayPlanError(
      "destination_opt_in_requires_note",
      "destinations_enabled=true requires destination_opt_in_note (architecture rule: external delivery during replay needs explicit opt-in)",
    );
  }

  // ---- chunking ------------------------------------------------------
  const chunks = chunkWindow(windowFrom, windowTo);

  // ---- risk flags ----------------------------------------------------
  const riskCodes = new Set<ReplayRiskCode>();
  const windowDays = (windowTo.getTime() - windowFrom.getTime()) / MILLIS_PER_DAY;
  if (windowDays > WIDE_WINDOW_DAYS_THRESHOLD) {
    riskCodes.add("wide_time_window");
  }
  // Fires on the operator's acknowledgement, for any target — not just
  // `destinations`. Deliberately NOT on `reachesDestinations` alone: every
  // v1 replay publishes to raw.events, so that would be on for every plan,
  // and a risk flag that is always lit is one people learn to skip.
  if (destinationsEnabled) {
    riskCodes.add("destination_sends_enabled");
  }
  if (target === "processor") {
    const pName = trimToNull(declaration.processor_name);
    const pVersion = trimToNull(declaration.processor_version);
    if (pName === null || pVersion === null) {
      riskCodes.add("processor_target_not_pinned");
    }
  }
  if (trimToNull(declaration.event_id) !== null) {
    riskCodes.add("single_event_replay");
  }
  if (environment === "production") {
    riskCodes.add("production_scope");
  }

  // ---- consumer group -----------------------------------------------
  const consumerGroup = buildConsumerGroup({
    projectId,
    environment,
    target,
    replayJobId: declaration.replay_job_id,
  });

  return {
    replay_job_id: declaration.replay_job_id,
    project_id: projectId,
    environment,
    target,
    mode,
    event_name: trimToNull(declaration.event_name),
    event_id: trimToNull(declaration.event_id),
    source_topic_family: SOURCE_TOPIC_FAMILY,
    target_topic_family: targetTopicFamily,
    reaches_destinations: reachesDestinations,
    partition_key_strategy: "project_environment_identity",
    window_from: windowFrom.toISOString(),
    window_to: windowTo.toISOString(),
    chunks,
    chunk_count: chunks.length,
    chunk_size_days: DEFAULT_CHUNK_SIZE_DAYS,
    processor_name: trimToNull(declaration.processor_name),
    processor_version: trimToNull(declaration.processor_version),
    destinations_enabled: destinationsEnabled,
    destination_opt_in_note: destinationOptInNote,
    consumer_group: consumerGroup,
    events_estimated: null,
    risks: formatRisks(riskCodes),
    planned_at: now.toISOString(),
    planner_version: "v1",
  };
}

// ---------------------------------------------------------------------------
// normalisers
// ---------------------------------------------------------------------------

function normaliseEnvironment(value: string | undefined | null): ReplayPlanEnvironment {
  if (value === undefined || value === null) {
    throw new ReplayPlanError("invalid_environment", "environment is required");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ReplayPlanError("invalid_environment", "environment is required");
  }
  if (!(REPLAY_PLAN_ENVIRONMENTS as readonly string[]).includes(trimmed)) {
    throw new ReplayPlanError(
      "invalid_environment",
      `environment must be one of: ${REPLAY_PLAN_ENVIRONMENTS.join(", ")} (got "${trimmed}")`,
    );
  }
  return trimmed as ReplayPlanEnvironment;
}

function normaliseTarget(value: string | undefined | null): ReplayPlanTarget {
  if (value === undefined || value === null) {
    throw new ReplayPlanError("invalid_target", "target is required");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ReplayPlanError("invalid_target", "target is required");
  }
  if (!(REPLAY_PLAN_TARGETS as readonly string[]).includes(trimmed)) {
    throw new ReplayPlanError(
      "invalid_target",
      `target must be one of: ${REPLAY_PLAN_TARGETS.join(", ")} (got "${trimmed}")`,
    );
  }
  return trimmed as ReplayPlanTarget;
}

function normaliseMode(value: string | undefined | null): ReplayPlanMode {
  if (value === undefined || value === null) return "dry_run";
  const trimmed = value.trim();
  if (trimmed.length === 0) return "dry_run";
  if (!(REPLAY_PLAN_MODES as readonly string[]).includes(trimmed)) {
    throw new ReplayPlanError(
      "invalid_mode",
      `mode must be one of: ${REPLAY_PLAN_MODES.join(", ")} (got "${trimmed}")`,
    );
  }
  return trimmed as ReplayPlanMode;
}

function requireNonEmpty(
  value: string | undefined | null,
  code: ReplayPlanRejectionCode,
  message: string,
): string {
  if (value === undefined || value === null) {
    throw new ReplayPlanError(code, message);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ReplayPlanError(code, message);
  }
  return trimmed;
}

function parseDate(value: Date | string, code: ReplayPlanRejectionCode, flag: string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new ReplayPlanError(code, `${flag} is not a valid Date`);
    }
    return value;
  }
  if (typeof value !== "string") {
    throw new ReplayPlanError(code, `${flag} must be a Date or ISO 8601 string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ReplayPlanError(code, `${flag} is required`);
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new ReplayPlanError(
      code,
      `${flag} must be an ISO 8601 timestamp (e.g. 2026-05-01T00:00:00Z); got "${value}"`,
    );
  }
  return parsed;
}

function trimToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// ---------------------------------------------------------------------------
// chunking
// ---------------------------------------------------------------------------

/**
 * Split the window into 1-day chunks. The final chunk's `to` always
 * equals the window's `to`, so the sum of chunks equals the window
 * exactly even when the window is not a whole-day multiple.
 *
 * Edge cases:
 *
 *   - zero-duration windows (`window_from === window_to`) produce a
 *     single zero-width chunk so the executor still has something to
 *     iterate.
 *   - sub-day windows produce a single chunk spanning the whole window.
 *   - windows that straddle day boundaries are split on UTC day
 *     boundaries: `[from .. midnight)`, `[midnight .. midnight)`, ...
 *     `[midnight .. to]`. The split is intentionally on UTC midnight
 *     not on `from + 24h` so the chunk indexes line up with calendar
 *     days operators see in dashboards.
 */
export function chunkWindow(windowFrom: Date, windowTo: Date): readonly ReplayPlanChunk[] {
  const chunks: ReplayPlanChunk[] = [];
  const start = windowFrom.getTime();
  const end = windowTo.getTime();
  if (end <= start) {
    chunks.push({
      index: 0,
      from: windowFrom.toISOString(),
      to: windowTo.toISOString(),
    });
    return chunks;
  }
  let cursor = start;
  let index = 0;
  while (cursor < end) {
    const nextMidnight = nextUtcMidnight(cursor);
    const chunkEnd = Math.min(nextMidnight, end);
    chunks.push({
      index,
      from: new Date(cursor).toISOString(),
      to: new Date(chunkEnd).toISOString(),
    });
    cursor = chunkEnd;
    index += 1;
  }
  return chunks;
}

/**
 * Next UTC midnight strictly after `epoch_ms`. When `epoch_ms` lands
 * exactly on midnight, returns 24 hours later (so the function always
 * makes forward progress and the chunk loop terminates).
 */
function nextUtcMidnight(epochMs: number): number {
  const d = new Date(epochMs);
  const midnight = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + 1, // next day at 00:00:00 UTC
    0,
    0,
    0,
    0,
  );
  return midnight;
}

// ---------------------------------------------------------------------------
// consumer group
// ---------------------------------------------------------------------------

/**
 * Build the consumer-group name the executor will join. The job-id
 * suffix guarantees a globally-unique group per replay so a pause /
 * cancel cannot affect another in-flight replay.
 *
 * `project_id` and `environment` are included so an operator grepping
 * RabbitMQ for "polaris-replay.<project>.<env>" finds every active
 * replay for that scope.
 */
export function buildConsumerGroup(input: {
  readonly projectId: string;
  readonly environment: string;
  readonly target: string;
  readonly replayJobId: string;
}): string {
  return `polaris-replay.${input.projectId}.${input.environment}.${input.target}.${input.replayJobId}`;
}

// ---------------------------------------------------------------------------
// risk formatting
// ---------------------------------------------------------------------------

/**
 * Stable narrative copy for each risk code. Kept in code rather than
 * inline at the call site so the test surface can assert one row per
 * code and the human renderer renders the same string the JSON view
 * carries.
 */
const RISK_MESSAGES: Readonly<Record<ReplayRiskCode, string>> = {
  wide_time_window:
    "replay window is wider than 7 days; expect many partitions and high lag during replay",
  destination_sends_enabled:
    "destination delivery is ENABLED for this replay (external sends will happen)",
  processor_target_not_pinned:
    "target=processor but processor_name/processor_version is not pinned in the declaration; executor will refuse to start",
  single_event_replay: "replay is scoped to a single event_id (surgical retry)",
  production_scope:
    "environment is production; require operator approval before promoting from dry_run to live",
};

/**
 * Project the risk-code set onto an ordered, deduped list of risk
 * notes. Ordering follows the closed-set declaration order in
 * {@link REPLAY_RISK_CODES} so the human-rendered dry-run is stable
 * across runs.
 */
function formatRisks(codes: ReadonlySet<ReplayRiskCode>): readonly ReplayPlanRisk[] {
  const order: ReplayRiskCode[] = [
    "wide_time_window",
    "destination_sends_enabled",
    "processor_target_not_pinned",
    "single_event_replay",
    "production_scope",
  ];
  return order
    .filter((code) => codes.has(code))
    .map((code) => ({ code, message: RISK_MESSAGES[code] }));
}
