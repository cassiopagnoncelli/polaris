/**
 * `polaris replay pause <replay_job_id> --reason "..."` — mutating.
 *
 * Transitions a non-terminal replay job to `status='paused'`. The executor
 * (P7-003) honors the paused status by halting mid-stream at the next
 * checkpoint. Pause is idempotent: pausing an already-paused job is a no-op.
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
  pauseReplayJobWithAudit,
  type ReplayJobRow,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";

interface ReplayPauseArgs {
  readonly replayJobId: string;
  readonly reason?: string;
}

export interface ReplayPauseStore {
  findById(replayJobId: string): Promise<ReplayJobRow | null>;
  pauseWithAudit(input: ReplayPauseStoreInput): Promise<ReplayPauseOutcome>;
  close(): Promise<void>;
}

export interface ReplayPauseStoreInput {
  readonly replayJobId: string;
  readonly pausedAt: Date;
  readonly reason: string;
  readonly auditId: string;
  readonly actorSource: AuditActorSource;
  readonly actorLabel: string;
  readonly projectId: string;
  readonly environment: AuditEnvironment;
  readonly before: ReplayJobRow;
}

export type ReplayPauseOutcome =
  | { readonly kind: "paused"; readonly row: ReplayJobRow }
  | { readonly kind: "not_pausable"; readonly row: ReplayJobRow }
  | { readonly kind: "not_found" };

export interface ReplayPauseHooks {
  readonly openStore?: () => ReplayPauseStore;
  readonly now?: () => Date;
  readonly generateAuditId?: () => string;
  readonly actorLabel?: () => string;
}

export const replayPauseCommand: CommandDefinition = {
  id: "replay.pause",
  mutates: true,
  register: (parent, deps) => {
    const cmd = parent
      .command("pause <replay_job_id>")
      .description("Pause an in-flight replay job. Idempotent.")
      .requiredOption("--reason <text>", "Operator-supplied rationale.");
    cmd.action(async (replayJobId: string, opts: { reason?: string }, command: Command) => {
      const wrapped = deps.runCommand<ReplayPauseArgs>(
        { id: "replay.pause", mutates: true },
        runReplayPause,
      );
      const args: ReplayPauseArgs = {
        replayJobId,
        ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      };
      await wrapped(args, command);
    });
  },
};

export function buildReplayPauseRunner(hooks: ReplayPauseHooks = {}) {
  const nowFn = hooks.now ?? (() => new Date());
  const generateAuditId = hooks.generateAuditId ?? (() => `polaris_aud_${uuidv7()}`);
  const actorLabel = hooks.actorLabel;

  return async function runner(args: ReplayPauseArgs, ctx: CommandContext): Promise<undefined> {
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
      const result = await store.pauseWithAudit({
        replayJobId: id,
        pausedAt: nowFn(),
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

const runReplayPause = buildReplayPauseRunner();

function defaultStore(env: NodeJS.ProcessEnv): ReplayPauseStore {
  const handle = connectDb({ env });
  return {
    findById: (id) => findReplayJobById(handle.db, id),
    pauseWithAudit: async (input) => {
      const row = await findReplayJobById(handle.db, input.replayJobId);
      if (row === null) return { kind: "not_found" as const };

      const outcome = await pauseReplayJobWithAudit(
        handle.db,
        { row },
        {
          auditId: input.auditId,
          actorSource: input.actorSource,
          actorLabel: input.actorLabel,
          reason: input.reason,
          occurredAt: input.pausedAt,
          before: input.before,
        },
      );

      const after = await findReplayJobById(handle.db, input.replayJobId);
      if (after === null) return { kind: "not_found" as const };
      // applied=false means the guard matched nothing: a peer got there
      // first, or the row was never in a pauselable state.
      return outcome.applied
        ? { kind: "paused" as const, row: after }
        : { kind: "not_pausable" as const, row: after };
    },
    close: () => handle.close(),
  };
}

function emit(ctx: CommandContext, outcome: ReplayPauseOutcome): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(outcome),
      json: outcome,
    }),
  );
}

function renderHuman(outcome: ReplayPauseOutcome): string {
  if (outcome.kind === "paused") return `paused replay job ${outcome.row.replay_job_id}`;
  if (outcome.kind === "not_pausable") {
    return `replay job ${outcome.row.replay_job_id}: status ${outcome.row.status} is not pausable`;
  }
  return "replay job: not found";
}
