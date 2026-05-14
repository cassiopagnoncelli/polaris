/**
 * `polaris replay resume <replay_job_id> --reason "..."` — mutating.
 *
 * Transitions a paused replay job back to `status='running'`. The executor
 * (P7-003) picks it up at the next checkpoint. Resume on a non-paused job
 * is rejected with a clear error.
 *
 * `mutates: true`: routes through the P6-007 production gate.
 *
 * @see docs/architecture/05-processors-and-replay.md "Replay Control Plane"
 * @see docs/implementation/tasks/P7-001-replay-job-model-cli.md
 */
import type { Command } from "commander";
import { v7 as uuidv7 } from "uuid";
import type { CommandContext, CommandDefinition } from "../../command.js";
import {
  type AuditActorSource,
  type AuditEnvironment,
  connectDb,
  findReplayJobById,
  insertAuditRecord,
  type ReplayJobRow,
  resumeReplayJob,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";

interface ReplayResumeArgs {
  readonly replayJobId: string;
  readonly reason?: string;
}

export interface ReplayResumeStore {
  findById(replayJobId: string): Promise<ReplayJobRow | null>;
  resumeWithAudit(input: ReplayResumeStoreInput): Promise<ReplayResumeOutcome>;
  close(): Promise<void>;
}

export interface ReplayResumeStoreInput {
  readonly replayJobId: string;
  readonly resumedAt: Date;
  readonly reason: string;
  readonly auditId: string;
  readonly actorSource: AuditActorSource;
  readonly actorLabel: string;
  readonly projectId: string;
  readonly environment: AuditEnvironment;
  readonly before: ReplayJobRow;
}

export type ReplayResumeOutcome =
  | { readonly kind: "resumed"; readonly row: ReplayJobRow }
  | { readonly kind: "not_paused"; readonly row: ReplayJobRow }
  | { readonly kind: "not_found" };

export interface ReplayResumeHooks {
  readonly openStore?: () => ReplayResumeStore;
  readonly now?: () => Date;
  readonly generateAuditId?: () => string;
  readonly actorLabel?: () => string;
}

export const replayResumeCommand: CommandDefinition = {
  id: "replay.resume",
  mutates: true,
  register: (parent, deps) => {
    const cmd = parent
      .command("resume <replay_job_id>")
      .description("Resume a paused replay job back to running.")
      .requiredOption("--reason <text>", "Operator-supplied rationale.");
    cmd.action(async (replayJobId: string, opts: { reason?: string }, command: Command) => {
      const wrapped = deps.runCommand<ReplayResumeArgs>(
        { id: "replay.resume", mutates: true },
        runReplayResume,
      );
      const args: ReplayResumeArgs = {
        replayJobId,
        ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      };
      await wrapped(args, command);
    });
  },
};

export function buildReplayResumeRunner(hooks: ReplayResumeHooks = {}) {
  const openStore = hooks.openStore ?? defaultStore;
  const nowFn = hooks.now ?? (() => new Date());
  const generateAuditId = hooks.generateAuditId ?? (() => `polaris_aud_${uuidv7()}`);
  const actorLabel = hooks.actorLabel;

  return async function runner(args: ReplayResumeArgs, ctx: CommandContext): Promise<undefined> {
    const id = args.replayJobId.trim();
    if (id.length === 0) {
      throw new UsageError("replay_job_id is required");
    }
    const reason = (args.reason ?? "").trim();
    if (reason.length === 0) {
      throw new UsageError("--reason is required");
    }

    const store = openStore();
    try {
      const existing = await store.findById(id);
      if (existing === null) {
        throw new UsageError(`replay job "${id}" not found`);
      }
      const result = await store.resumeWithAudit({
        replayJobId: id,
        resumedAt: nowFn(),
        reason,
        auditId: generateAuditId(),
        actorSource: ctx.actor.source as AuditActorSource,
        actorLabel: actorLabel?.() ?? ctx.actor.label,
        projectId: existing.project_id,
        environment: existing.environment as AuditEnvironment,
        before: existing,
      });
      emit(ctx, result);
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runReplayResume = buildReplayResumeRunner();

function defaultStore(): ReplayResumeStore {
  const handle = connectDb({ env: process.env });
  return {
    findById: (id) => findReplayJobById(handle.db, id),
    resumeWithAudit: async (input) =>
      handle.db.transaction().execute(async (trx) => {
        // v1 only supports resume to 'running'. The planner (P7-002) restores
        // the prior status when it re-picks up the job; we default to running
        // here so the executor (P7-003) gets a clear signal to start.
        const resumed = await resumeReplayJob(trx, input.replayJobId, "running", input.resumedAt);
        if (!resumed) {
          const after = await findReplayJobById(trx, input.replayJobId);
          if (after === null) return { kind: "not_found" as const };
          return { kind: "not_paused" as const, row: after };
        }
        await insertAuditRecord(trx, {
          audit_id: input.auditId,
          actor_source: input.actorSource,
          actor_label: input.actorLabel,
          action: "replay.resume",
          target_type: "replay_job",
          target_id: input.replayJobId,
          project_id: input.projectId,
          environment: input.environment,
          before: input.before as unknown as Record<string, unknown>,
          after: { ...input.before, status: "running" } as unknown as Record<string, unknown>,
          reason: input.reason,
        });
        const after = await findReplayJobById(trx, input.replayJobId);
        if (after === null) {
          throw new Error(`replay resume: row "${input.replayJobId}" disappeared mid-transaction`);
        }
        return { kind: "resumed" as const, row: after };
      }),
    close: () => handle.close(),
  };
}

function emit(ctx: CommandContext, outcome: ReplayResumeOutcome): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(outcome),
      json: outcome,
    }),
  );
}

function renderHuman(outcome: ReplayResumeOutcome): string {
  if (outcome.kind === "resumed") return `resumed replay job ${outcome.row.replay_job_id}`;
  if (outcome.kind === "not_paused") {
    return `replay job ${outcome.row.replay_job_id}: status ${outcome.row.status} is not paused`;
  }
  return "replay job: not found";
}
