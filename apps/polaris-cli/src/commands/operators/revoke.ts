/**
 * `polaris operators revoke <operator_token_id> [--reason <text>]` — mutating.
 *
 * Sets `status='revoked'` and stamps `revoked_at` on the row. Idempotent:
 * running it twice is not an error. The CLI prints "already revoked" on
 * the second call and exits 0 so scripts can re-run without bracketing
 * each call in a try/catch.
 *
 * The resolver treats any non-`'active'` row as not-usable; revocation
 * takes effect on the next CLI invocation that tries to use the token.
 *
 * Audit trail: when the transition lands, this command INSERTs a row into
 * `audit_records` inside the SAME transaction as the status UPDATE. The
 * optional `--reason` flag is stored verbatim on the audit row. Neither
 * `before` nor `after` carries the argon2id hash.
 *
 * `mutates: true`. The production-mutation gate from P6-007 plugs in.
 */
import type { Command } from "commander";
import { v7 as uuidv7 } from "uuid";

import type { CommandContext, CommandDefinition } from "../../command.js";
import {
  type AuditActorSource,
  connectDb,
  findOperatorTokenById,
  insertAuditRecord,
  type OperatorTokenRow,
  revokeOperatorToken,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import type { OperatorTokenAuditSnapshot } from "./create.js";

interface OperatorsRevokeArgs {
  readonly operatorTokenId: string;
  readonly reason?: string;
}

export interface OperatorsRevokeAuditPayload {
  readonly auditId: string;
  readonly actorSource: AuditActorSource;
  readonly actorLabel: string;
  readonly occurredAt: Date;
  readonly before: OperatorTokenAuditSnapshot;
  readonly after: OperatorTokenAuditSnapshot;
  readonly reason: string | null;
}

export interface OperatorsRevokeStore {
  findById(operatorTokenId: string): Promise<OperatorTokenRow | null>;
  revokeWithAudit(
    operatorTokenId: string,
    revokedAt: Date,
    audit: OperatorsRevokeAuditPayload,
  ): Promise<boolean>;
  close(): Promise<void>;
}

export interface OperatorsRevokeHooks {
  readonly openStore?: () => OperatorsRevokeStore;
  readonly now?: () => Date;
  readonly generateAuditId?: () => string;
}

export const operatorsRevokeCommand: CommandDefinition = {
  id: "operators.revoke",
  mutates: true,
  register: (parent, deps) => {
    const cmd = parent
      .command("revoke <operator_token_id>")
      .description(
        "Revoke an operator token. Idempotent: re-running on a revoked token prints `already revoked` and exits 0.",
      )
      .option("--reason <reason>", "Operator rationale stamped on the audit record (optional).");
    cmd.action(async (operatorTokenId: string, opts: { reason?: string }, command: Command) => {
      const wrapped = deps.runCommand<OperatorsRevokeArgs>(
        { id: "operators.revoke", mutates: true },
        runOperatorsRevoke,
      );
      const args: OperatorsRevokeArgs = {
        operatorTokenId,
        ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      };
      await wrapped(args, command);
    });
  },
};

export function buildOperatorsRevokeRunner(hooks: OperatorsRevokeHooks = {}) {
  const openStore = hooks.openStore ?? defaultStore;
  const nowFn = hooks.now ?? (() => new Date());
  const generateAuditId = hooks.generateAuditId ?? uuidv7;

  return async function runner(args: OperatorsRevokeArgs, ctx: CommandContext): Promise<undefined> {
    const id = args.operatorTokenId.trim();
    if (id.length === 0) {
      throw new UsageError("operator_token_id is required");
    }
    const reason = args.reason?.trim();
    if (reason !== undefined && reason.length > 1024) {
      throw new UsageError("--reason must be 1024 characters or fewer");
    }

    const store = openStore();
    try {
      const existing = await store.findById(id);
      if (existing === null) {
        throw new UsageError(`operator token "${id}" not found`);
      }

      if (existing.status !== "active") {
        emit(ctx, {
          operatorTokenId: id,
          applied: false,
          status: existing.status,
          revokedAt: existing.revoked_at,
        });
        return undefined;
      }

      const now = nowFn();
      const auditId = generateAuditId();
      const before = toSnapshot(existing);
      const after: OperatorTokenAuditSnapshot = {
        ...before,
        status: "revoked",
        revoked_at: now.toISOString(),
      };
      const auditPayload: OperatorsRevokeAuditPayload = {
        auditId,
        actorSource: ctx.actor.source,
        actorLabel: ctx.actor.label,
        occurredAt: now,
        before,
        after,
        reason: reason ?? null,
      };

      const applied = await store.revokeWithAudit(id, now, auditPayload);
      if (!applied) {
        const afterRow = await store.findById(id);
        emit(ctx, {
          operatorTokenId: id,
          applied: false,
          status: afterRow?.status ?? "revoked",
          revokedAt: afterRow?.revoked_at ?? null,
        });
        return undefined;
      }

      ctx.logger.info(
        {
          audit_id: auditId,
          audit_action: "operators.revoke",
          operator_token_id: id,
          operator_label: existing.operator_label,
          actor_source: ctx.actor.source,
          actor_label: ctx.actor.label,
          previous_status: existing.status,
          new_status: "revoked",
          reason: reason ?? null,
          occurred_at: now.toISOString(),
        },
        "operator token revoked (audit row persisted)",
      );

      emit(ctx, {
        operatorTokenId: id,
        applied: true,
        status: "revoked",
        revokedAt: now.toISOString(),
      });
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runOperatorsRevoke = buildOperatorsRevokeRunner();

function defaultStore(): OperatorsRevokeStore {
  const handle = connectDb({ env: process.env });
  return {
    findById: (id) => findOperatorTokenById(handle.db, id),
    revokeWithAudit: async (id, revokedAt, audit) =>
      handle.db.transaction().execute(async (trx) => {
        const applied = await revokeOperatorToken(trx, id, revokedAt);
        if (!applied) return false;
        await insertAuditRecord(trx, {
          audit_id: audit.auditId,
          actor_source: audit.actorSource,
          actor_label: audit.actorLabel,
          action: "operators.revoke",
          target_type: "operator_token",
          target_id: id,
          project_id: null,
          environment: null,
          before: audit.before,
          after: audit.after,
          reason: audit.reason,
          request_id: audit.auditId,
          created_at: audit.occurredAt,
        });
        return true;
      }),
    close: () => handle.close(),
  };
}

function toSnapshot(row: OperatorTokenRow): OperatorTokenAuditSnapshot {
  return {
    operator_token_id: row.operator_token_id,
    operator_label: row.operator_label,
    status: row.status,
    hash_algorithm: row.hash_algorithm,
    revoked_at: row.revoked_at,
  };
}

interface EmitInput {
  readonly operatorTokenId: string;
  readonly applied: boolean;
  readonly status: string;
  readonly revokedAt: string | null;
}

function emit(ctx: CommandContext, input: EmitInput): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(input),
      json: {
        operator_token_id: input.operatorTokenId,
        applied: input.applied,
        status: input.status,
        revoked_at: input.revokedAt,
      },
    }),
  );
}

function renderHuman(input: EmitInput): string {
  if (input.applied) {
    return `revoked ${input.operatorTokenId} at ${input.revokedAt}`;
  }
  return `${input.operatorTokenId}: already ${input.status}${
    input.revokedAt !== null ? ` at ${input.revokedAt}` : ""
  }`;
}
