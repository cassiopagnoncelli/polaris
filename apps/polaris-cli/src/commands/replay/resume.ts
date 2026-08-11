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
  type ReplayJobRow,
  resumeReplayJobWithAudit,
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
  const nowFn = hooks.now ?? (() => new Date());
  const generateAuditId = hooks.generateAuditId ?? (() => `polaris_aud_${uuidv7()}`);
  const actorLabel = hooks.actorLabel;

  return async function runner(args: ReplayResumeArgs, ctx: CommandContext): Promise<undefined> {
    const openStore = hooks.openStore ?? (() => defaultStore(ctx.env));
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

function defaultStore(env: NodeJS.ProcessEnv): ReplayResumeStore {
  const handle = connectDb({ env });
  return {
    findById: (id) => findReplayJobById(handle.db, id),
    resumeWithAudit: async (input) => {
      const row = await findReplayJobById(handle.db, input.replayJobId);
      if (row === null) return { kind: "not_found" as const };

      // v1 only resumes to `running`: the executor takes a clear signal to
      // start, and the planner restores prior status when it re-picks the job.
      const outcome = await resumeReplayJobWithAudit(
        handle.db,
        { row, targetStatus: "running" },
        {
          auditId: input.auditId,
          actorSource: input.actorSource,
          actorLabel: input.actorLabel,
          reason: input.reason,
          occurredAt: input.resumedAt,
          before: input.before,
        },
      );

      const after = await findReplayJobById(handle.db, input.replayJobId);
      if (after === null) return { kind: "not_found" as const };
      return outcome.applied
        ? { kind: "resumed" as const, row: after }
        : { kind: "not_paused" as const, row: after };
    },
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
