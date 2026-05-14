/**
 * `polaris dlq mark-resolved <dlq_id> [--note "<text>"]` — mutating.
 *
 * Marks a DLQ record resolved without republishing. Use case: the
 * operator triaged the issue out-of-band (vendor support reprocessed the
 * event, a manual upload happened, the event is no longer relevant) and
 * wants to clear the row from the active triage queue.
 *
 * Idempotent: re-running on an already-resolved row exits 0 with an
 * "already resolved" message.
 *
 * Audit trail: writes a `dlq.mark-resolved` row to `audit_records` in
 * the same Kysely transaction as the row update. Snapshots include the
 * row state pre- and post-update; the `payload` bytes are NOT included
 * (kept small, side-effect-free) but every other column is.
 *
 * `mutates: true`. P6-007 gates this against production-without-token.
 */
import type { Command } from "commander";
import { v7 as uuidv7 } from "uuid";

import {
  type DlqRecord,
  type DlqRecordRepository,
  createKyselyDlqRecordRepository,
} from "@polaris/shared-destinations";

import type { CommandContext, CommandDefinition } from "../../command.js";
import {
  type AuditActorSource,
  type AuditEnvironment,
  connectDb,
  insertAuditRecord,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import { toAuditSnapshot } from "./snapshot.js";

interface DlqMarkResolvedArgs {
  readonly dlqId: string;
  readonly note?: string;
}

export interface DlqMarkResolvedAuditPayload {
  readonly auditId: string;
  readonly actorSource: AuditActorSource;
  readonly actorLabel: string;
  readonly occurredAt: Date;
  readonly before: ReturnType<typeof toAuditSnapshot>;
  readonly after: ReturnType<typeof toAuditSnapshot>;
  readonly projectId: string;
  readonly environment: AuditEnvironment;
  readonly note: string | null;
}

export interface DlqMarkResolvedStore {
  findById(dlq_id: string): Promise<DlqRecord | null>;
  markResolvedWithAudit(
    dlq_id: string,
    actorLabel: string,
    note: string | null,
    now: Date,
    audit: DlqMarkResolvedAuditPayload,
  ): Promise<DlqRecord>;
  close(): Promise<void>;
}

export interface DlqMarkResolvedHooks {
  readonly openStore?: () => DlqMarkResolvedStore;
  readonly now?: () => Date;
  readonly generateAuditId?: () => string;
  readonly actorLabel?: () => string;
}

export const dlqMarkResolvedCommand: CommandDefinition = {
  id: "dlq.mark-resolved",
  mutates: true,
  register: (parent, deps) => {
    const cmd = parent
      .command("mark-resolved <dlq_id>")
      .description("Mark a DLQ record resolved without republishing. Idempotent. Audited.")
      .option("--note <text>", "Optional operator-supplied resolution note (max 1024 chars).");
    cmd.action(async (dlqId: string, opts: { note?: string }, command: Command) => {
      const wrapped = deps.runCommand<DlqMarkResolvedArgs>(
        { id: "dlq.mark-resolved", mutates: true },
        runDlqMarkResolved,
      );
      const args: DlqMarkResolvedArgs = {
        dlqId,
        ...(opts.note !== undefined ? { note: opts.note } : {}),
      };
      await wrapped(args, command);
    });
  },
};

export function buildDlqMarkResolvedRunner(hooks: DlqMarkResolvedHooks = {}) {
  const openStore = hooks.openStore ?? defaultStore;
  const nowFn = hooks.now ?? (() => new Date());
  const generateAuditId = hooks.generateAuditId ?? (() => `polaris_aud_${uuidv7()}`);
  const actorLabelOverride = hooks.actorLabel;

  return async function runner(args: DlqMarkResolvedArgs, ctx: CommandContext): Promise<undefined> {
    const id = args.dlqId.trim();
    if (id.length === 0) {
      throw new UsageError("dlq_id is required");
    }
    const note = args.note?.trim();
    if (note !== undefined && note.length > 1024) {
      throw new UsageError("--note must be 1024 characters or fewer");
    }

    const store = openStore();
    try {
      const existing = await store.findById(id);
      if (existing === null) {
        throw new UsageError(`dlq record "${id}" not found`);
      }
      if (existing.resolved_at !== null) {
        emit(ctx, {
          dlqId: id,
          applied: false,
          resolvedAt: existing.resolved_at,
          resolvedBy: existing.resolved_by,
        });
        return undefined;
      }

      const now = nowFn();
      const auditId = generateAuditId();
      const actorLabel = actorLabelOverride?.() ?? ctx.actor.label;
      const noteValue = note === undefined || note.length === 0 ? null : note;
      const audit: DlqMarkResolvedAuditPayload = {
        auditId,
        actorSource: ctx.actor.source,
        actorLabel,
        occurredAt: now,
        before: toAuditSnapshot(existing),
        after: toAuditSnapshot({
          ...existing,
          resolved_at: now,
          resolved_by: actorLabel,
          resolution_note: noteValue,
        }),
        projectId: existing.project_id,
        environment: existing.environment as AuditEnvironment,
        note: noteValue,
      };

      const updated = await store.markResolvedWithAudit(id, actorLabel, noteValue, now, audit);

      ctx.logger.info(
        {
          audit_id: auditId,
          audit_action: "dlq.mark-resolved",
          dlq_id: id,
          destination_id: existing.destination_id,
          project_id: existing.project_id,
          environment: existing.environment,
          vendor: existing.vendor,
          resolved_by: actorLabel,
          occurred_at: now.toISOString(),
        },
        "dlq record marked resolved (audit row persisted)",
      );
      emit(ctx, {
        dlqId: id,
        applied: true,
        resolvedAt: updated.resolved_at,
        resolvedBy: updated.resolved_by,
      });
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runDlqMarkResolved = buildDlqMarkResolvedRunner();

function defaultStore(): DlqMarkResolvedStore {
  const handle = connectDb({ env: process.env });
  const repo: DlqRecordRepository = createKyselyDlqRecordRepository({ db: handle.db });
  return {
    findById: (id) => repo.findRecord(id),
    markResolvedWithAudit: async (id, actorLabel, note, now, audit) => {
      return handle.db.transaction().execute(async (trx) => {
        const trxRepo = createKyselyDlqRecordRepository({ db: trx });
        const outcome = await trxRepo.markResolved(id, actorLabel, note, now);
        await insertAuditRecord(trx, {
          audit_id: audit.auditId,
          actor_source: audit.actorSource,
          actor_label: audit.actorLabel,
          action: "dlq.mark-resolved",
          target_type: "dlq_record",
          target_id: id,
          project_id: audit.projectId,
          environment: audit.environment,
          before: audit.before,
          after: audit.after,
          reason: audit.note ?? null,
          request_id: audit.auditId,
          created_at: audit.occurredAt,
        });
        return outcome.record;
      });
    },
    close: () => handle.close(),
  };
}

interface EmitInput {
  readonly dlqId: string;
  readonly applied: boolean;
  readonly resolvedAt: Date | null;
  readonly resolvedBy: string | null;
}

function emit(ctx: CommandContext, input: EmitInput): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(input),
      json: {
        dlq_id: input.dlqId,
        applied: input.applied,
        resolved_at: input.resolvedAt === null ? null : input.resolvedAt.toISOString(),
        resolved_by: input.resolvedBy,
      },
    }),
  );
}

function renderHuman(input: EmitInput): string {
  if (input.applied) {
    return `resolved ${input.dlqId} by ${input.resolvedBy} at ${input.resolvedAt?.toISOString() ?? "-"}`;
  }
  return `${input.dlqId}: already resolved (by ${input.resolvedBy ?? "?"} at ${
    input.resolvedAt?.toISOString() ?? "?"
  })`;
}
