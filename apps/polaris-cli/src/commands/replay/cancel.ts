/**
 * `polaris replay cancel <replay_job_id> --reason "..."` — mutating.
 *
 * Transitions a non-terminal replay job to `status='cancelled'`. Cancellation
 * is idempotent — re-running on an already-terminal job prints
 * `already cancelled` (or whatever terminal state it sits in) and exits 0
 * so scripts can re-run without bracketing each call in a try/catch.
 *
 * The planner/executor (P7-002/P7-003) honor the cancelled status by
 * stopping mid-stream the next time they pick the job up.
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
  cancelReplayJob,
  connectDb,
  findReplayJobById,
  insertAuditRecord,
  isTerminalReplayStatus,
  type ReplayJobRow,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";

interface ReplayCancelArgs {
  readonly replayJobId: string;
  readonly reason?: string;
}

export interface ReplayCancelStore {
  cancelWithAudit(input: ReplayCancelStoreInput): Promise<ReplayCancelOutcome>;
  close(): Promise<void>;
}

export interface ReplayCancelStoreInput {
  readonly replayJobId: string;
  readonly cancelledAt: Date;
  readonly reason: string;
  readonly auditId: string;
  readonly actorSource: AuditActorSource;
  readonly actorLabel: string;
  readonly projectId: string;
  readonly environment: AuditEnvironment;
  readonly before: ReplayJobRow;
}

export type ReplayCancelOutcome =
  | { readonly kind: "cancelled"; readonly row: ReplayJobRow }
  | { readonly kind: "already_terminal"; readonly row: ReplayJobRow }
  | { readonly kind: "not_found" };

export interface ReplayCancelHooks {
  readonly openStore?: () => ReplayCancelStore;
  readonly now?: () => Date;
  readonly generateAuditId?: () => string;
  readonly actorLabel?: () => string;
}

export const replayCancelCommand: CommandDefinition = {
  id: "replay.cancel",
  mutates: true,
  register: (parent, deps) => {
    const cmd = parent
      .command("cancel <replay_job_id>")
      .description("Cancel a non-terminal replay job. Idempotent.")
      .requiredOption("--reason <text>", "Operator-supplied rationale.");
    cmd.action(async (replayJobId: string, opts: { reason?: string }, command: Command) => {
      const wrapped = deps.runCommand<ReplayCancelArgs>(
        { id: "replay.cancel", mutates: true },
        runReplayCancel,
      );
      const args: ReplayCancelArgs = {
        replayJobId,
        ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      };
      await wrapped(args, command);
    });
  },
};

export function buildReplayCancelRunner(hooks: ReplayCancelHooks = {}) {
  const openStore = hooks.openStore ?? defaultStore;
  const nowFn = hooks.now ?? (() => new Date());
  const generateAuditId = hooks.generateAuditId ?? (() => `polaris_aud_${uuidv7()}`);
  const actorLabel = hooks.actorLabel;

  return async function runner(args: ReplayCancelArgs, ctx: CommandContext): Promise<undefined> {
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
      const existing = await findExisting(store, id);
      if (existing === null) {
        throw new UsageError(`replay job "${id}" not found`);
      }
      if (isTerminalReplayStatus(existing.status)) {
        emit(ctx, { kind: "already_terminal", row: existing });
        return undefined;
      }
      const result = await store.cancelWithAudit({
        replayJobId: id,
        cancelledAt: nowFn(),
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

const runReplayCancel = buildReplayCancelRunner();

async function findExisting(store: ReplayCancelStore, id: string): Promise<ReplayJobRow | null> {
  // The store's findById helper lives on the connectDb handle; we fetch via the
  // default store path. Tests inject a fake store with its own findById.
  // (Cancellation needs the before-row both for the audit snapshot and the
  // terminal-status guard.)
  // biome-ignore lint/suspicious/noExplicitAny: dynamic dispatch for test stores
  const dynamic = store as any;
  if (typeof dynamic.findById === "function") {
    return (await dynamic.findById(id)) as ReplayJobRow | null;
  }
  throw new Error("replay cancel store must expose findById");
}

function defaultStore(): ReplayCancelStore {
  const handle = connectDb({ env: process.env });
  return {
    cancelWithAudit: async (input) =>
      handle.db.transaction().execute(async (trx) => {
        const cancelled = await cancelReplayJob(trx, input.replayJobId, input.cancelledAt);
        if (!cancelled) {
          // Race: another caller cancelled or completed first. Re-read and
          // surface idempotently.
          const after = await findReplayJobById(trx, input.replayJobId);
          if (after === null) {
            return { kind: "not_found" as const };
          }
          return { kind: "already_terminal" as const, row: after };
        }
        await insertAuditRecord(trx, {
          audit_id: input.auditId,
          actor_source: input.actorSource,
          actor_label: input.actorLabel,
          action: "replay.cancel",
          target_type: "replay_job",
          target_id: input.replayJobId,
          project_id: input.projectId,
          environment: input.environment,
          before: input.before as unknown as Record<string, unknown>,
          after: {
            ...input.before,
            status: "cancelled",
            finished_at: input.cancelledAt.toISOString(),
          } as unknown as Record<string, unknown>,
          reason: input.reason,
        });
        const after = await findReplayJobById(trx, input.replayJobId);
        if (after === null) {
          throw new Error(`replay cancel: row "${input.replayJobId}" disappeared mid-transaction`);
        }
        return { kind: "cancelled" as const, row: after };
      }),
    findById: (id: string) => findReplayJobById(handle.db, id),
    close: () => handle.close(),
  } as ReplayCancelStore & { findById: (id: string) => Promise<ReplayJobRow | null> };
}

function emit(ctx: CommandContext, outcome: ReplayCancelOutcome): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(outcome),
      json: outcome,
    }),
  );
}

function renderHuman(outcome: ReplayCancelOutcome): string {
  if (outcome.kind === "cancelled") {
    return `cancelled replay job ${outcome.row.replay_job_id}`;
  }
  if (outcome.kind === "already_terminal") {
    return `replay job ${outcome.row.replay_job_id}: already ${outcome.row.status}`;
  }
  return "replay job: not found";
}
