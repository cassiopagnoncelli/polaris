/**
 * `polaris replay create --project <id> --env <env> --target <t>
 *   --from <iso> --to <iso> [--event <name>] [--event-id <id>]
 *   [--mode <dry_run|live>] --reason "..."`
 *
 * Mutating: inserts one replay-job row scoped to a `(project, environment)`
 * tuple with a UTC time window bounded by the operational retention window
 * (90 days for `raw.events`). The `replay_job_id` is platform-issued as
 * `polaris_rpj_<uuidv7>` so operators never pass it in.
 *
 * **Window-bound rule:** the CLI MUST reject `--from` values older than 90
 * days from the runner's clock. The error code is `replay_window_exceeded`.
 * The migration does NOT encode the bound (it would couple PostgreSQL to
 * the Redpanda retention config); the CLI is the gate.
 *
 * **Planner rule:** the CLI MUST NOT accept flags that resemble PLAN
 * semantics (partitioning, chunking, transform overrides, topic routing).
 * Those live in versioned code under the planner package (P7-002). The
 * `rejectReplayPlanArguments` gate fires BEFORE any DB write.
 *
 * Audit trail: when the row INSERTs, this command writes an audit_records
 * row in the SAME transaction. The audit row captures the full window +
 * scope so a future incident review can see exactly what the operator
 * requested.
 *
 * `mutates: true` so the P6-007 production gate picks this command up
 * automatically.
 *
 * @see docs/architecture/05-processors-and-replay.md "Replay Control Plane"
 * @see docs/implementation/tasks/P7-001-replay-job-model-cli.md
 */
import { v7 as uuidv7 } from "uuid";
import type { CommandContext, CommandDefinition } from "../../command.js";
import {
  type AuditActorSource,
  type AuditEnvironment,
  connectDb,
  insertAuditRecord,
  insertReplayJob,
  type InsertReplayJobInput,
  REPLAY_JOB_MODES,
  REPLAY_JOB_TARGETS,
  type ReplayJobMode,
  type ReplayJobTarget,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import { generateReplayJobId } from "./id.js";
import {
  assertWithinReplayWindow,
  parseIsoTimestamp,
  rejectReplayPlanArguments,
} from "./validation.js";

const SUPPORTED_ENVIRONMENTS = ["development", "staging", "production"] as const;
type SupportedEnvironment = (typeof SUPPORTED_ENVIRONMENTS)[number];

interface ReplayCreateArgs {
  readonly project?: string;
  readonly env?: string;
  readonly target?: string;
  readonly from?: string;
  readonly to?: string;
  readonly event?: string;
  readonly eventId?: string;
  readonly mode?: string;
  readonly reason?: string;
}

/**
 * Snapshot the runner places into the `audit_records.after` JSON. The
 * shape is the operational columns of the replay job at insertion time.
 * `before` is NULL for creates.
 */
export interface ReplayJobAuditSnapshot {
  readonly replay_job_id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly event_name: string | null;
  readonly event_id: string | null;
  readonly window_from: string;
  readonly window_to: string;
  readonly target: ReplayJobTarget;
  readonly mode: ReplayJobMode;
  readonly status: string;
  readonly created_by: string;
}

export interface ReplayCreateAuditPayload {
  readonly auditId: string;
  readonly actorSource: AuditActorSource;
  readonly actorLabel: string;
  readonly occurredAt: Date;
  readonly after: ReplayJobAuditSnapshot;
  readonly projectId: string;
  readonly environment: AuditEnvironment;
  readonly reason: string;
}

export interface ReplayCreateStore {
  insertWithAudit(input: InsertReplayJobInput, audit: ReplayCreateAuditPayload): Promise<void>;
  close(): Promise<void>;
}

export interface ReplayCreateHooks {
  readonly issueId?: () => string;
  readonly openStore?: () => ReplayCreateStore;
  readonly now?: () => Date;
  readonly generateAuditId?: () => string;
  readonly actorLabel?: () => string;
}

export const replayCreateCommand: CommandDefinition = {
  id: "replay.create",
  mutates: true,
  register: (parent, deps) => {
    parent
      .command("create")
      .description(
        [
          "Issue a replay job. Records the operator's intent (scope + window + target);",
          "the planner (P7-002) and executor (P7-003) advance the lifecycle.",
          "",
          "Replay is bounded to the 90-day operational retention window for raw.events.",
          "Requests older than that are rejected with `replay_window_exceeded`.",
        ].join("\n"),
      )
      .requiredOption("--project <project_id>", "Project to replay.")
      .requiredOption("--env <environment>", "Environment: development | staging | production.")
      .requiredOption(
        "--target <target>",
        `Subsystem to replay into: ${REPLAY_JOB_TARGETS.join(" | ")}.`,
      )
      .requiredOption(
        "--from <iso>",
        "Inclusive window start (ISO 8601 UTC, e.g. 2026-05-01T00:00:00Z).",
      )
      .requiredOption(
        "--to <iso>",
        "Inclusive window end (ISO 8601 UTC, e.g. 2026-05-02T00:00:00Z).",
      )
      .option("--event <name>", "Restrict the replay to a single canonical event name.")
      .option(
        "--event-id <id>",
        "Restrict the replay to a single event_id (rare; usually combined with --event).",
      )
      .option("--mode <mode>", `Dispatch mode: ${REPLAY_JOB_MODES.join(" | ")} (default: dry_run).`)
      .requiredOption(
        "--reason <reason>",
        "Operator-supplied rationale for the audit record (free text, required).",
      )
      .action(deps.runCommand({ id: "replay.create", mutates: true }, runReplayCreate));
  },
};

export function buildReplayCreateRunner(hooks: ReplayCreateHooks = {}) {
  const issueId = hooks.issueId ?? generateReplayJobId;
  const openStore = hooks.openStore ?? defaultStore;
  const nowFn = hooks.now ?? (() => new Date());
  const generateAuditId = hooks.generateAuditId ?? uuidv7;
  const actorLabelOverride = hooks.actorLabel;

  return async function runner(args: ReplayCreateArgs, ctx: CommandContext): Promise<undefined> {
    rejectReplayPlanArguments(args as unknown as Record<string, unknown>);
    const now = nowFn();
    const validated = validate(args, now);
    const replayJobId = issueId();
    const actorLabel = actorLabelOverride?.() ?? ctx.actor.label;

    const insertInput: InsertReplayJobInput = {
      replay_job_id: replayJobId,
      project_id: validated.project,
      environment: validated.env,
      window_from: validated.from,
      window_to: validated.to,
      target: validated.target,
      mode: validated.mode,
      created_by: actorLabel,
      reason: validated.reason,
      ...(validated.event !== undefined ? { event_name: validated.event } : {}),
      ...(validated.eventId !== undefined ? { event_id: validated.eventId } : {}),
    };

    const auditId = generateAuditId();
    const auditPayload: ReplayCreateAuditPayload = {
      auditId,
      actorSource: ctx.actor.source,
      actorLabel,
      occurredAt: now,
      after: {
        replay_job_id: replayJobId,
        project_id: validated.project,
        environment: validated.env,
        event_name: validated.event ?? null,
        event_id: validated.eventId ?? null,
        window_from: validated.from.toISOString(),
        window_to: validated.to.toISOString(),
        target: validated.target,
        mode: validated.mode,
        status: "pending",
        created_by: actorLabel,
      },
      projectId: validated.project,
      environment: validated.env,
      reason: validated.reason,
    };

    const store = openStore();
    try {
      await store.insertWithAudit(insertInput, auditPayload);

      ctx.logger.info(
        {
          audit_id: auditId,
          audit_action: "replay.create",
          replay_job_id: replayJobId,
          project_id: validated.project,
          environment: validated.env,
          target: validated.target,
          mode: validated.mode,
          window_from: validated.from.toISOString(),
          window_to: validated.to.toISOString(),
          event_name: validated.event ?? null,
          event_id: validated.eventId ?? null,
          reason: validated.reason,
          occurred_at: now.toISOString(),
        },
        "replay job created (audit row persisted)",
      );

      emit(ctx, {
        replayJobId,
        project: validated.project,
        env: validated.env,
        target: validated.target,
        mode: validated.mode,
        windowFrom: validated.from.toISOString(),
        windowTo: validated.to.toISOString(),
        eventName: validated.event ?? null,
        eventId: validated.eventId ?? null,
        reason: validated.reason,
        createdBy: actorLabel,
      });
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runReplayCreate = buildReplayCreateRunner();

function defaultStore(): ReplayCreateStore {
  const handle = connectDb({ env: process.env });
  return {
    insertWithAudit: async (input, audit) =>
      handle.db.transaction().execute(async (trx) => {
        await insertReplayJob(trx, input);
        await insertAuditRecord(trx, {
          audit_id: audit.auditId,
          actor_source: audit.actorSource,
          actor_label: audit.actorLabel,
          action: "replay.create",
          target_type: "replay_job",
          target_id: input.replay_job_id,
          project_id: audit.projectId,
          environment: audit.environment,
          before: null,
          after: audit.after,
          reason: audit.reason,
          request_id: audit.auditId,
          created_at: audit.occurredAt,
        });
      }),
    close: () => handle.close(),
  };
}

interface ValidatedArgs {
  readonly project: string;
  readonly env: SupportedEnvironment;
  readonly target: ReplayJobTarget;
  readonly from: Date;
  readonly to: Date;
  readonly event: string | undefined;
  readonly eventId: string | undefined;
  readonly mode: ReplayJobMode;
  readonly reason: string;
}

function validate(args: ReplayCreateArgs, now: Date): ValidatedArgs {
  const project = requireTrim(args.project, "--project");
  const env = requireTrim(args.env, "--env");
  const target = requireTrim(args.target, "--target");
  const fromStr = requireTrim(args.from, "--from");
  const toStr = requireTrim(args.to, "--to");
  const reason = requireTrim(args.reason, "--reason");

  if (!(SUPPORTED_ENVIRONMENTS as readonly string[]).includes(env)) {
    throw new UsageError(
      `--env must be one of: ${SUPPORTED_ENVIRONMENTS.join(", ")} (got "${env}")`,
    );
  }
  if (!(REPLAY_JOB_TARGETS as readonly string[]).includes(target)) {
    throw new UsageError(
      `--target must be one of: ${REPLAY_JOB_TARGETS.join(", ")} (got "${target}")`,
    );
  }
  if (reason.length > 1024) {
    throw new UsageError("--reason must be 1024 characters or fewer");
  }

  const from = parseIsoTimestamp(fromStr, "--from");
  const to = parseIsoTimestamp(toStr, "--to");
  if (to.getTime() < from.getTime()) {
    throw new UsageError(
      `--to (${to.toISOString()}) must be at or after --from (${from.toISOString()})`,
    );
  }
  assertWithinReplayWindow(from, now);

  const mode = parseMode(args.mode);
  const event = trim(args.event);
  const eventId = trim(args.eventId);
  if (event !== undefined && event.length > 256) {
    throw new UsageError("--event must be 256 characters or fewer");
  }
  if (eventId !== undefined && eventId.length > 256) {
    throw new UsageError("--event-id must be 256 characters or fewer");
  }

  return {
    project,
    env: env as SupportedEnvironment,
    target: target as ReplayJobTarget,
    from,
    to,
    event,
    eventId,
    mode,
    reason,
  };
}

function parseMode(raw: string | undefined): ReplayJobMode {
  if (raw === undefined) return "dry_run";
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "dry_run";
  if (!(REPLAY_JOB_MODES as readonly string[]).includes(trimmed)) {
    throw new UsageError(
      `--mode must be one of: ${REPLAY_JOB_MODES.join(", ")} (got "${trimmed}")`,
    );
  }
  return trimmed as ReplayJobMode;
}

function requireTrim(value: string | undefined, flag: string): string {
  if (value === undefined) throw new UsageError(`${flag} is required`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new UsageError(`${flag} is required`);
  return trimmed;
}

function trim(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

interface EmitInput {
  readonly replayJobId: string;
  readonly project: string;
  readonly env: string;
  readonly target: ReplayJobTarget;
  readonly mode: ReplayJobMode;
  readonly windowFrom: string;
  readonly windowTo: string;
  readonly eventName: string | null;
  readonly eventId: string | null;
  readonly reason: string;
  readonly createdBy: string;
}

function emit(ctx: CommandContext, input: EmitInput): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(input),
      json: {
        replay_job_id: input.replayJobId,
        project_id: input.project,
        environment: input.env,
        target: input.target,
        mode: input.mode,
        window_from: input.windowFrom,
        window_to: input.windowTo,
        event_name: input.eventName,
        event_id: input.eventId,
        status: "pending",
        created_by: input.createdBy,
        reason: input.reason,
      },
    }),
  );
}

function renderHuman(input: EmitInput): string {
  const lines = [
    `polaris replay job created`,
    `  replay_job_id   ${input.replayJobId}`,
    `  project_id      ${input.project}`,
    `  environment     ${input.env}`,
    `  target          ${input.target}`,
    `  mode            ${input.mode}`,
    `  window_from     ${input.windowFrom}`,
    `  window_to       ${input.windowTo}`,
  ];
  if (input.eventName !== null) {
    lines.push(`  event_name      ${input.eventName}`);
  }
  if (input.eventId !== null) {
    lines.push(`  event_id        ${input.eventId}`);
  }
  lines.push(`  status          pending`);
  lines.push(`  created_by      ${input.createdBy}`);
  lines.push(`  reason          ${input.reason}`);
  return lines.join("\n");
}
