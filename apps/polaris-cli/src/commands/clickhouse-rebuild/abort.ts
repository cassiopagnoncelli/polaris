/**
 * `polaris clickhouse-rebuild abort <id> --reason "..."` — mutating.
 *
 * Transitions an abortable rebuild job to `status='aborted'` and
 * stamps `completed_at` + `updated_at`. Abortable from `pending`,
 * `planning`, or `dry_run`; terminal states (`completed`, `failed`,
 * `aborted`) are idempotent — the runner prints "already terminal"
 * and exits 0 so scripts can re-run without try/catch bracketing.
 *
 * The deferred executor (P7-005-followup) honors the aborted status
 * by stopping mid-stream the next time it picks the job up.
 *
 * Writes the matching `audit_records` row in the SAME transaction.
 *
 * `mutates: true`: routes through the P6-007 production gate.
 *
 * @see docs/development/clickhouse-rebuilds.md
 */
import type { Command } from "commander";
import { v7 as uuidv7 } from "uuid";
import type { CommandContext, CommandDefinition } from "../../command.js";
import {
  type AuditActorSource,
  abortClickhouseRebuildJob,
  type ClickhouseRebuildJobRow,
  connectDb,
  findClickhouseRebuildJobById,
  insertAuditRecord,
  isTerminalClickhouseRebuildStatus,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";

interface ClickhouseRebuildAbortArgs {
  readonly id: string;
  readonly reason?: string;
}

export interface ClickhouseRebuildAbortStore {
  findById(jobId: string): Promise<ClickhouseRebuildJobRow | null>;
  abortWithAudit(input: ClickhouseRebuildAbortStoreInput): Promise<ClickhouseRebuildAbortOutcome>;
  close(): Promise<void>;
}

export interface ClickhouseRebuildAbortStoreInput {
  readonly jobId: string;
  readonly abortedAt: Date;
  readonly reason: string;
  readonly auditId: string;
  readonly actorSource: AuditActorSource;
  readonly actorLabel: string;
  readonly before: ClickhouseRebuildJobRow;
}

export type ClickhouseRebuildAbortOutcome =
  | { readonly kind: "aborted"; readonly row: ClickhouseRebuildJobRow }
  | { readonly kind: "already_terminal"; readonly row: ClickhouseRebuildJobRow }
  | { readonly kind: "not_found" };

export interface ClickhouseRebuildAbortHooks {
  readonly openStore?: () => ClickhouseRebuildAbortStore;
  readonly now?: () => Date;
  readonly generateAuditId?: () => string;
  readonly actorLabel?: () => string;
}

export const clickhouseRebuildAbortCommand: CommandDefinition = {
  id: "clickhouse-rebuild.abort",
  mutates: true,
  register: (parent, deps) => {
    const cmd = parent
      .command("abort <clickhouse_rebuild_job_id>")
      .description("Abort an in-flight clickhouse rebuild job. Idempotent on terminal jobs.")
      .requiredOption("--reason <text>", "Operator-supplied rationale.");
    cmd.action(async (id: string, opts: { reason?: string }, command: Command) => {
      const wrapped = deps.runCommand<ClickhouseRebuildAbortArgs>(
        { id: "clickhouse-rebuild.abort", mutates: true },
        runAbort,
      );
      const args: ClickhouseRebuildAbortArgs = {
        id,
        ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      };
      await wrapped(args, command);
    });
  },
};

export function buildClickhouseRebuildAbortRunner(hooks: ClickhouseRebuildAbortHooks = {}) {
  const nowFn = hooks.now ?? (() => new Date());
  const generateAuditId = hooks.generateAuditId ?? (() => `polaris_aud_${uuidv7()}`);
  const actorLabel = hooks.actorLabel;

  return async function runner(
    args: ClickhouseRebuildAbortArgs,
    ctx: CommandContext,
  ): Promise<undefined> {
    const openStore = hooks.openStore ?? (() => defaultStore(ctx.env));
    const id = args.id.trim();
    if (id.length === 0) {
      throw new UsageError("clickhouse_rebuild_job_id is required");
    }
    const reason = (args.reason ?? "").trim();
    if (reason.length === 0) {
      throw new UsageError("--reason is required");
    }

    const store = openStore();
    try {
      const existing = await store.findById(id);
      if (existing === null) {
        throw new UsageError(`clickhouse rebuild job "${id}" not found`);
      }
      if (isTerminalClickhouseRebuildStatus(existing.status)) {
        emit(ctx, { kind: "already_terminal", row: existing });
        return undefined;
      }
      const result = await store.abortWithAudit({
        jobId: id,
        abortedAt: nowFn(),
        reason,
        auditId: generateAuditId(),
        actorSource: ctx.actor.source as AuditActorSource,
        actorLabel: actorLabel?.() ?? ctx.actor.label,
        before: existing,
      });
      emit(ctx, result);
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runAbort = buildClickhouseRebuildAbortRunner();

function defaultStore(env: NodeJS.ProcessEnv): ClickhouseRebuildAbortStore {
  const handle = connectDb({ env });
  return {
    findById: (id) => findClickhouseRebuildJobById(handle.db, id),
    abortWithAudit: async (input) =>
      handle.db.transaction().execute(async (trx) => {
        const aborted = await abortClickhouseRebuildJob(trx, input.jobId, input.abortedAt);
        if (!aborted) {
          const after = await findClickhouseRebuildJobById(trx, input.jobId);
          if (after === null) return { kind: "not_found" as const };
          return { kind: "already_terminal" as const, row: after };
        }
        await insertAuditRecord(trx, {
          audit_id: input.auditId,
          actor_source: input.actorSource,
          actor_label: input.actorLabel,
          action: "clickhouse-rebuild.abort",
          target_type: "clickhouse_rebuild_job",
          target_id: input.jobId,
          project_id: null,
          environment: null,
          before: input.before as unknown as Record<string, unknown>,
          after: {
            ...input.before,
            status: "aborted",
            completed_at: input.abortedAt.toISOString(),
            updated_at: input.abortedAt.toISOString(),
          } as unknown as Record<string, unknown>,
          reason: input.reason,
        });
        const after = await findClickhouseRebuildJobById(trx, input.jobId);
        if (after === null) {
          throw new Error(
            `clickhouse-rebuild abort: row "${input.jobId}" disappeared mid-transaction`,
          );
        }
        return { kind: "aborted" as const, row: after };
      }),
    close: () => handle.close(),
  };
}

function emit(ctx: CommandContext, outcome: ClickhouseRebuildAbortOutcome): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(outcome),
      json: outcome,
    }),
  );
}

function renderHuman(outcome: ClickhouseRebuildAbortOutcome): string {
  if (outcome.kind === "aborted") {
    return `aborted clickhouse rebuild job ${outcome.row.clickhouse_rebuild_job_id}`;
  }
  if (outcome.kind === "already_terminal") {
    return `clickhouse rebuild job ${outcome.row.clickhouse_rebuild_job_id}: already ${outcome.row.status}`;
  }
  return "clickhouse rebuild job: not found";
}
