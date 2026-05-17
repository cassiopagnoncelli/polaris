/**
 * `polaris clickhouse-rebuild create --projection <name>
 *   [--from <iso>] [--to <iso>] [--dry-run] --reason "..."` — mutating.
 *
 * Records an operator-issued request to rebuild one ClickHouse
 * projection from `polaris.analytics_raw`.
 *
 * Two paths:
 *
 *   --dry-run                runs the planner, persists a `dry_run`
 *                            row with the planner's row / partition
 *                            estimates, prints the plan, exits 0. No
 *                            ClickHouse writes happen anywhere.
 *
 *   (no --dry-run)           persists a `pending` row, then invokes
 *                            the rebuild executor (GWNZH1N5) which
 *                            transitions pending --> running -->
 *                            completed / failed and stamps the row
 *                            with the outcome. Exits 0 on
 *                            `completed`, non-zero on `failed` /
 *                            `aborted`.
 *
 * Both paths write an `audit_records` row in the SAME transaction as
 * the rebuild-job row.
 *
 * `mutates: true` so the P6-007 production gate picks this command
 * up automatically.
 *
 * @see docs/architecture/07-clickhouse.md "Replay and Rebuild"
 * @see docs/development/clickhouse-rebuilds.md
 * @see packages/shared-clickhouse/src/rebuild/
 */
import { createClickHouseClient } from "@polaris/shared-clickhouse";
import {
  type ClickhouseRebuildDriver,
  type ClickhouseRebuildOutcome,
  type ClickhouseRebuildPlan,
  type ClickhouseRebuildPlanned,
  type ClickhouseRebuildStore,
  createClickhouseRebuildDriver,
  executeClickhouseRebuild,
  findRebuildableProjection,
  type PlanClickhouseRebuildOptions,
  planClickhouseRebuild,
  REBUILDABLE_CLICKHOUSE_PROJECTION_NAMES,
  renderClickhouseRebuildPlanHuman,
} from "@polaris/shared-clickhouse/rebuild";
import { clickhouseEnvSchema } from "@polaris/shared-config";
import { v7 as uuidv7 } from "uuid";
import type { CommandContext, CommandDefinition, CommandResult } from "../../command.js";
import {
  type AuditActorSource,
  connectDb,
  type InsertClickhouseRebuildJobInput,
  insertAuditRecord,
  insertClickhouseRebuildJob,
  markClickhouseRebuildJobCompleted,
  markClickhouseRebuildJobFailed,
  markClickhouseRebuildJobRunning,
} from "../../db/index.js";
import { CliError, ConfigError, ExitCode, UsageError } from "../../errors.js";
import { renderAccordingTo, renderJson } from "../../output.js";
import { generateClickhouseRebuildJobId } from "./id.js";

interface ClickhouseRebuildCreateArgs {
  readonly projection?: string;
  readonly from?: string;
  readonly to?: string;
  readonly dryRun?: boolean;
  readonly reason?: string;
}

/**
 * Snapshot stamped onto `audit_records.after`. The `before` slot is
 * NULL for creates (mirrors the destinations / replay create
 * conventions).
 */
export interface ClickhouseRebuildJobAuditSnapshot {
  readonly clickhouse_rebuild_job_id: string;
  readonly target_projection: string;
  readonly target_table_qualified: string;
  readonly source_range_from: string | null;
  readonly source_range_to: string | null;
  readonly status: string;
  readonly rows_estimated: number | null;
  readonly partitions_estimated: number | null;
  readonly requester_actor_label: string;
}

export interface ClickhouseRebuildCreateAuditPayload {
  readonly auditId: string;
  readonly actorSource: AuditActorSource;
  readonly actorLabel: string;
  readonly occurredAt: Date;
  readonly after: ClickhouseRebuildJobAuditSnapshot;
  readonly reason: string;
}

export interface ClickhouseRebuildCreateStore {
  insertWithAudit(
    input: InsertClickhouseRebuildJobInput,
    audit: ClickhouseRebuildCreateAuditPayload,
  ): Promise<void>;
  close(): Promise<void>;
}

export interface ClickhouseRebuildCreateHooks {
  readonly issueId?: () => string;
  readonly openStore?: () => ClickhouseRebuildCreateStore;
  readonly now?: () => Date;
  readonly generateAuditId?: () => string;
  readonly actorLabel?: () => string;
  /**
   * Adapter that reads `system.parts` for the planner. Injected for
   * tests; in production this wraps the shared-clickhouse operator
   * client's `raw.query` escape hatch with an audit reason of
   * `clickhouse-rebuild-plan`.
   *
   * Omit to test the `clickhouse_unreachable` path explicitly.
   */
  readonly readPartitions?: PlanClickhouseRebuildOptions["readPartitions"];
  /**
   * Lifecycle store the rebuild executor calls (GWNZH1N5). Injected
   * for tests; production opens a fresh Kysely-backed store. Only
   * consulted on the non-dry-run path.
   */
  readonly openExecutorStore?: () => ClickhouseRebuildExecutorStoreHandle;
  /**
   * Driver the rebuild executor calls. Injected for tests;
   * production opens an operator-profile ClickHouse client. Only
   * consulted on the non-dry-run path. Receives the job id so the
   * production driver can stamp it onto the raw.query audit reason
   * for every clearSlice / INSERT.
   */
  readonly openDriver?: (input: {
    readonly jobId: string;
    readonly env: NodeJS.ProcessEnv;
  }) => Promise<ClickhouseRebuildDriverHandle>;
}

export interface ClickhouseRebuildExecutorStoreHandle {
  readonly store: ClickhouseRebuildStore;
  close(): Promise<void>;
}

export interface ClickhouseRebuildDriverHandle {
  readonly driver: ClickhouseRebuildDriver;
  close(): Promise<void>;
}

export const clickhouseRebuildCreateCommand: CommandDefinition = {
  id: "clickhouse-rebuild.create",
  mutates: true,
  register: (parent, deps) => {
    parent
      .command("create")
      .description(
        [
          "Issue a ClickHouse rebuild job for one analytical projection.",
          "",
          "With --dry-run, runs the planner and persists a `dry_run` row carrying the",
          "planner's row / partition estimates. Without --dry-run, persists a `pending`",
          "row and then invokes the rebuild executor, which drives pending -> running ->",
          "completed (or failed) and stamps the row with the outcome. Exits non-zero on",
          "failed / aborted.",
          "",
          `Allowed --projection values: ${REBUILDABLE_CLICKHOUSE_PROJECTION_NAMES.join(", ")}`,
        ].join("\n"),
      )
      .requiredOption(
        "--projection <name>",
        `Projection to rebuild. Closed set: ${REBUILDABLE_CLICKHOUSE_PROJECTION_NAMES.join(" | ")}.`,
      )
      .option(
        "--from <iso>",
        "Inclusive source-range start (ISO 8601 UTC). Both --from and --to or neither.",
      )
      .option("--to <iso>", "Inclusive source-range end (ISO 8601 UTC).")
      .option(
        "--dry-run",
        "Plan only; persist a `dry_run` row. Without --dry-run, the executor runs and the row transitions through to completed / failed.",
      )
      .requiredOption(
        "--reason <reason>",
        "Operator-supplied rationale for the audit record (free text, required).",
      )
      .action(deps.runCommand({ id: "clickhouse-rebuild.create", mutates: true }, runCreate));
  },
};

export function buildClickhouseRebuildCreateRunner(hooks: ClickhouseRebuildCreateHooks = {}) {
  const issueId = hooks.issueId ?? generateClickhouseRebuildJobId;
  const nowFn = hooks.now ?? (() => new Date());
  const generateAuditId = hooks.generateAuditId ?? (() => `polaris_aud_${uuidv7()}`);
  const actorLabelOverride = hooks.actorLabel;
  const readPartitions = hooks.readPartitions;

  return async function runner(
    args: ClickhouseRebuildCreateArgs,
    ctx: CommandContext,
  ): Promise<CommandResult | undefined> {
    const openStore = hooks.openStore ?? (() => defaultStore(ctx.env));
    const openExecutorStore = hooks.openExecutorStore ?? (() => defaultExecutorStore(ctx.env));
    const openDriver = hooks.openDriver ?? defaultDriver;
    const now = nowFn();
    const validated = validate(args);
    const jobId = issueId();
    const actorLabel = actorLabelOverride?.() ?? ctx.actor.label;

    // ---- planning ---------------------------------------------------
    // Run the planner regardless of --dry-run; the persisted row
    // benefits from the estimate. The planner is read-only so this
    // is safe on the non-dry-run path too.
    const planOptions: PlanClickhouseRebuildOptions = {
      now,
      ...(readPartitions !== undefined ? { readPartitions } : {}),
    };
    const plan = await planClickhouseRebuild(
      {
        projection: validated.projection,
        fromTs: validated.from ?? null,
        toTs: validated.to ?? null,
      },
      planOptions,
    );

    if (plan.kind === "rejected") {
      // Surface the planner's structured code in the exit-code
      // message so scripts can grep `clickhouse_rebuild_rejected:<code>`.
      throw new UsageError(`clickhouse_rebuild_rejected:${plan.code}: ${plan.message}`, {
        code: plan.code,
      });
    }

    // ---- DB write ---------------------------------------------------
    const targetStatus = validated.dryRun ? "dry_run" : "pending";
    const insertInput: InsertClickhouseRebuildJobInput = {
      clickhouse_rebuild_job_id: jobId,
      target_projection: plan.projection,
      target_table_qualified: plan.targetTableQualified,
      source_range_from: validated.from ?? null,
      source_range_to: validated.to ?? null,
      reason: validated.reason,
      requester_actor_label: actorLabel,
      status: targetStatus,
      rows_estimated: plan.rowsTotalEstimated,
      partitions_estimated: plan.partitionCount,
    };

    const auditId = generateAuditId();
    const auditPayload: ClickhouseRebuildCreateAuditPayload = {
      auditId,
      actorSource: ctx.actor.source as AuditActorSource,
      actorLabel,
      occurredAt: now,
      after: {
        clickhouse_rebuild_job_id: jobId,
        target_projection: plan.projection,
        target_table_qualified: plan.targetTableQualified,
        source_range_from: validated.from === undefined ? null : validated.from.toISOString(),
        source_range_to: validated.to === undefined ? null : validated.to.toISOString(),
        status: targetStatus,
        rows_estimated: plan.rowsTotalEstimated,
        partitions_estimated: plan.partitionCount,
        requester_actor_label: actorLabel,
      },
      reason: validated.reason,
    };

    const store = openStore();
    try {
      await store.insertWithAudit(insertInput, auditPayload);
    } finally {
      await store.close();
    }

    ctx.logger.info(
      {
        audit_id: auditId,
        audit_action: "clickhouse-rebuild.create",
        clickhouse_rebuild_job_id: jobId,
        target_projection: plan.projection,
        target_table_qualified: plan.targetTableQualified,
        dry_run: validated.dryRun,
        status: targetStatus,
        rows_estimated: plan.rowsTotalEstimated,
        partitions_estimated: plan.partitionCount,
        occurred_at: now.toISOString(),
      },
      validated.dryRun
        ? "clickhouse rebuild dry-run row persisted (audit row persisted)"
        : "clickhouse rebuild pending row persisted (audit row persisted; executor next)",
    );

    // ---- output -----------------------------------------------------
    emit(ctx, {
      jobId,
      status: targetStatus,
      dryRun: validated.dryRun,
      plan,
      reason: validated.reason,
      createdBy: actorLabel,
    });

    if (!validated.dryRun) {
      // Drive the rebuild through the executor (GWNZH1N5). The
      // executor handles the pending→running→completed|failed
      // transitions itself; we just supply the store + driver
      // seams and surface the outcome.
      const executorStoreHandle = openExecutorStore();
      const driverHandle = await openDriver({ jobId, env: ctx.env });
      let outcome: ClickhouseRebuildOutcome;
      try {
        outcome = await executeClickhouseRebuild({
          plan,
          clickhouse_rebuild_job_id: jobId,
          store: executorStoreHandle.store,
          driver: driverHandle.driver,
          now: nowFn,
        });
      } finally {
        try {
          await driverHandle.close();
        } catch {
          // best-effort
        }
        try {
          await executorStoreHandle.close();
        } catch {
          // best-effort
        }
      }

      ctx.logger.info(
        {
          audit_action: "clickhouse-rebuild.execute",
          clickhouse_rebuild_job_id: jobId,
          target_projection: plan.projection,
          target_table_qualified: plan.targetTableQualified,
          outcome_status: outcome.status,
          rows_inserted_total: outcome.rows_inserted_total,
          partition_count: outcome.partitions.length,
          started_at: outcome.started_at,
          finished_at: outcome.finished_at,
          ...(outcome.error !== null
            ? {
                err: {
                  name: outcome.error.error_class,
                  message: outcome.error.error_message,
                },
              }
            : {}),
        },
        outcome.status === "completed"
          ? "clickhouse rebuild completed"
          : outcome.status === "failed"
            ? "clickhouse rebuild failed"
            : "clickhouse rebuild aborted",
      );

      ctx.output.writeOut(
        renderAccordingTo(ctx.config.output, {
          human: renderOutcomeHuman(jobId, outcome),
          json: outcome,
        }),
      );

      if (outcome.status === "failed") {
        throw new CliError(
          `clickhouse_rebuild_failed: ${jobId} terminated with ${outcome.error?.error_class ?? "Error"}: ${outcome.error?.error_message ?? "(no message)"}`,
          {
            exitCode: ExitCode.GenericFailure,
            details: {
              clickhouse_rebuild_job_id: jobId,
              status: "failed",
              error_class: outcome.error?.error_class ?? null,
            },
          },
        );
      }
      if (outcome.status === "aborted") {
        throw new CliError(
          `clickhouse_rebuild_aborted: ${jobId} was aborted before the executor could start`,
          {
            exitCode: ExitCode.GenericFailure,
            details: { clickhouse_rebuild_job_id: jobId, status: "aborted" },
          },
        );
      }
    }

    return undefined;
  };
}

function renderOutcomeHuman(jobId: string, outcome: ClickhouseRebuildOutcome): string {
  const lines = [
    `clickhouse_rebuild_job_id ${jobId}`,
    `status                    ${outcome.status}`,
    `started_at                ${outcome.started_at}`,
    `finished_at               ${outcome.finished_at}`,
    `rows_inserted_total       ${outcome.rows_inserted_total}`,
    `partitions_processed      ${outcome.partitions.length}`,
  ];
  if (outcome.error !== null) {
    lines.push(`error_class               ${outcome.error.error_class}`);
    lines.push(`error_message             ${outcome.error.error_message}`);
  }
  return `${lines.join("\n")}\n`;
}

const runCreate = buildClickhouseRebuildCreateRunner();

function defaultStore(env: NodeJS.ProcessEnv): ClickhouseRebuildCreateStore {
  const handle = connectDb({ env });
  return {
    insertWithAudit: async (input, audit) =>
      handle.db.transaction().execute(async (trx) => {
        await insertClickhouseRebuildJob(trx, input);
        await insertAuditRecord(trx, {
          audit_id: audit.auditId,
          actor_source: audit.actorSource,
          actor_label: audit.actorLabel,
          action: "clickhouse-rebuild.create",
          target_type: "clickhouse_rebuild_job",
          target_id: input.clickhouse_rebuild_job_id,
          project_id: null,
          environment: null,
          before: null,
          after: audit.after as unknown as Record<string, unknown>,
          reason: audit.reason,
          request_id: audit.auditId,
          created_at: audit.occurredAt,
        });
      }),
    close: () => handle.close(),
  };
}

function defaultExecutorStore(env: NodeJS.ProcessEnv): ClickhouseRebuildExecutorStoreHandle {
  const handle = connectDb({ env });
  const store: ClickhouseRebuildStore = {
    markRunning: async (input) =>
      markClickhouseRebuildJobRunning(handle.db, input.clickhouse_rebuild_job_id, input.now),
    markCompleted: async (input) =>
      markClickhouseRebuildJobCompleted(
        handle.db,
        input.clickhouse_rebuild_job_id,
        input.now,
        input.rows_inserted,
      ),
    markFailed: async (input) =>
      markClickhouseRebuildJobFailed(
        handle.db,
        input.clickhouse_rebuild_job_id,
        input.now,
        input.error_class,
        input.error_message,
      ),
  };
  return {
    store,
    close: () => handle.close(),
  };
}

/**
 * Production default driver: an operator-profile ClickHouse client
 * wrapped by `createClickhouseRebuildDriver`. Reads
 * `POLARIS_CLICKHOUSE_*` from the CLI invocation's env (threaded via
 * `ctx.env`), refuses with a `ConfigError` (exit code 3) if operator
 * credentials are not configured — same shape `connectDb` uses for
 * the Postgres URL.
 *
 * Tests inject their own driver via `hooks.openDriver`, so this
 * function is only consulted in production.
 */
async function defaultDriver(input: {
  readonly jobId: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<ClickhouseRebuildDriverHandle> {
  let parsed: ReturnType<typeof clickhouseEnvSchema.parse>;
  try {
    parsed = clickhouseEnvSchema.parse(input.env);
  } catch (cause) {
    throw new ConfigError(
      `POLARIS_CLICKHOUSE_* env is required for non-dry-run rebuilds: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (parsed.operator === undefined) {
    throw new ConfigError(
      "POLARIS_CLICKHOUSE_OPERATOR_USER and POLARIS_CLICKHOUSE_OPERATOR_PASSWORD are required to run a non-dry-run rebuild. The rebuild driver uses the operator profile so its raw SQL leaves an audit trail.",
    );
  }
  const client = createClickHouseClient({
    role: "operator",
    url: parsed.url,
    database: parsed.database,
    credential: {
      username: parsed.operator.user,
      password: parsed.operator.password,
    },
    requestTimeoutMs: parsed.requestTimeoutMs,
    maxOpenConnections: parsed.maxOpenConnections,
    application: "polaris-cli",
  });
  const driver = createClickhouseRebuildDriver({
    raw: client.raw,
    jobId: input.jobId,
  });
  return {
    driver,
    close: () => client.close(),
  };
}

interface ValidatedArgs {
  readonly projection: string;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly dryRun: boolean;
  readonly reason: string;
}

function validate(args: ClickhouseRebuildCreateArgs): ValidatedArgs {
  const projection = requireTrim(args.projection, "--projection");
  const reason = requireTrim(args.reason, "--reason");
  if (reason.length > 1024) {
    throw new UsageError("--reason must be 1024 characters or fewer");
  }

  // Resolve the projection name against the closed registry BEFORE
  // touching anything else. The planner would also reject this, but
  // surfacing the usage error here keeps the CLI's `--help` output
  // and the runtime rejection in sync.
  if (findRebuildableProjection(projection) === null) {
    throw new UsageError(
      `--projection must be one of: ${REBUILDABLE_CLICKHOUSE_PROJECTION_NAMES.join(", ")} (got "${projection}")`,
    );
  }

  const fromStr = trim(args.from);
  const toStr = trim(args.to);
  if ((fromStr === undefined) !== (toStr === undefined)) {
    throw new UsageError(
      "--from and --to must be supplied together (full-table rebuild uses neither).",
    );
  }
  let from: Date | undefined;
  let to: Date | undefined;
  if (fromStr !== undefined && toStr !== undefined) {
    from = parseIso(fromStr, "--from");
    to = parseIso(toStr, "--to");
    if (to.getTime() < from.getTime()) {
      throw new UsageError(
        `--to (${to.toISOString()}) must be at or after --from (${from.toISOString()})`,
      );
    }
    if (to.getTime() === from.getTime()) {
      throw new UsageError(
        `--from and --to are the same instant (${to.toISOString()}); a zero-width window selects no partitions.`,
      );
    }
  }

  const result: {
    projection: string;
    dryRun: boolean;
    reason: string;
    from?: Date;
    to?: Date;
  } = {
    projection,
    dryRun: Boolean(args.dryRun),
    reason,
  };
  if (from !== undefined) result.from = from;
  if (to !== undefined) result.to = to;
  return result;
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

function parseIso(value: string, flag: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new UsageError(
      `${flag} must be an ISO 8601 timestamp (e.g. 2026-05-01T00:00:00Z), got "${value}"`,
    );
  }
  return parsed;
}

interface EmitInput {
  readonly jobId: string;
  readonly status: string;
  readonly dryRun: boolean;
  readonly plan: ClickhouseRebuildPlan;
  readonly reason: string;
  readonly createdBy: string;
}

function emit(ctx: CommandContext, input: EmitInput): void {
  const planned = input.plan.kind === "planned" ? (input.plan as ClickhouseRebuildPlanned) : null;
  if (ctx.config.output === "json") {
    ctx.output.writeOut(
      renderJson({
        clickhouse_rebuild_job_id: input.jobId,
        status: input.status,
        dry_run: input.dryRun,
        reason: input.reason,
        requester_actor_label: input.createdBy,
        plan: planned,
      }),
    );
    return;
  }
  const human: string[] = [
    input.dryRun
      ? `polaris clickhouse-rebuild created (dry-run)`
      : `polaris clickhouse-rebuild created (pending; executor next)`,
    `  clickhouse_rebuild_job_id  ${input.jobId}`,
    `  status                     ${input.status}`,
    `  requester_actor_label      ${input.createdBy}`,
    `  reason                     ${input.reason}`,
  ];
  if (planned !== null) {
    human.push("", renderClickhouseRebuildPlanHuman(planned));
  }
  ctx.output.writeOut(
    renderAccordingTo("human", {
      human: human.join("\n"),
      json: null,
    }),
  );
}
