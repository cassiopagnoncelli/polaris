/**
 * `polaris keys revoke <api_key_id> [--reason <text>]` — mutating.
 *
 * Sets `status='revoked'` and stamps `revoked_at` on the row. The operation
 * is idempotent: running it twice is not an error. The CLI prints
 * "already revoked" on the second call and exits 0 so scripts can re-run
 * without bracketing each call in a try/catch.
 *
 * The ingester treats any non-`'active'` row as not-usable; revocation takes
 * effect on the next request that misses the auth cache (default TTL: 60s).
 *
 * Audit trail: when the transition lands, this command INSERTs a row into
 * `audit_records` inside the SAME transaction as the status UPDATE. The
 * optional `--reason` flag is stored verbatim on the audit row. Neither
 * `before` nor `after` carries the argon2id hash.
 *
 * `mutates: true`. P6-007 gates this against production-without-token.
 */
import type { Command } from "commander";
import { v7 as uuidv7 } from "uuid";
import type { CommandContext, CommandDefinition } from "../../command.js";
import {
  type ApiKeyRow,
  type AuditActorSource,
  type AuditEnvironment,
  connectDb,
  findApiKeyById,
  insertAuditRecord,
  revokeApiKey,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import type { KeyAuditSnapshot } from "./create.js";

interface KeysRevokeArgs {
  readonly apiKeyId: string;
  readonly reason?: string;
}

export interface KeysRevokeAuditPayload {
  readonly auditId: string;
  readonly actorSource: AuditActorSource;
  readonly actorLabel: string;
  readonly occurredAt: Date;
  readonly before: KeyAuditSnapshot;
  readonly after: KeyAuditSnapshot;
  readonly projectId: string;
  readonly environment: AuditEnvironment;
  readonly reason: string | null;
}

export interface KeysRevokeStore {
  findById(apiKeyId: string): Promise<ApiKeyRow | null>;
  revokeWithAudit(
    apiKeyId: string,
    revokedAt: Date,
    audit: KeysRevokeAuditPayload,
  ): Promise<boolean>;
  close(): Promise<void>;
}

export interface KeysRevokeHooks {
  readonly openStore?: () => KeysRevokeStore;
  readonly now?: () => Date;
  readonly generateAuditId?: () => string;
  readonly actorLabel?: () => string;
}

export const keysRevokeCommand: CommandDefinition = {
  id: "keys.revoke",
  mutates: true,
  register: (parent, deps) => {
    const cmd = parent
      .command("revoke <api_key_id>")
      .description(
        "Revoke an API key. Idempotent: re-running on a revoked key prints `already revoked` and exits 0.",
      )
      .option("--reason <reason>", "Operator rationale stamped on the audit record (optional).");
    cmd.action(async (apiKeyId: string, opts: { reason?: string }, command: Command) => {
      const wrapped = deps.runCommand<KeysRevokeArgs>(
        { id: "keys.revoke", mutates: true },
        runKeysRevoke,
      );
      const args: KeysRevokeArgs = {
        apiKeyId,
        ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      };
      await wrapped(args, command);
    });
  },
};

export function buildKeysRevokeRunner(hooks: KeysRevokeHooks = {}) {
  const nowFn = hooks.now ?? (() => new Date());
  const generateAuditId = hooks.generateAuditId ?? uuidv7;
  const actorLabelOverride = hooks.actorLabel;

  return async function runner(args: KeysRevokeArgs, ctx: CommandContext): Promise<undefined> {
    const openStore = hooks.openStore ?? (() => defaultStore(ctx.env));
    const id = args.apiKeyId.trim();
    if (id.length === 0) {
      throw new UsageError("api_key_id is required");
    }
    const reason = args.reason?.trim();
    if (reason !== undefined && reason.length > 1024) {
      throw new UsageError("--reason must be 1024 characters or fewer");
    }

    const store = openStore();
    try {
      const existing = await store.findById(id);
      if (existing === null) {
        throw new UsageError(`api key "${id}" not found`);
      }

      if (existing.status !== "active") {
        // Idempotent path: row is already revoked. No audit row written
        // because no state change happened.
        emit(ctx, {
          apiKeyId: id,
          applied: false,
          status: existing.status,
          revokedAt: existing.revoked_at,
        });
        return undefined;
      }

      const now = nowFn();
      const auditId = generateAuditId();
      const before = toSnapshot(existing);
      const after: KeyAuditSnapshot = {
        ...before,
        status: "revoked",
        revoked_at: now.toISOString(),
      };
      const auditPayload: KeysRevokeAuditPayload = {
        auditId,
        actorSource: ctx.actor.source,
        actorLabel: actorLabelOverride?.() ?? ctx.actor.label,
        occurredAt: now,
        before,
        after,
        projectId: existing.project_id,
        environment: existing.environment as AuditEnvironment,
        reason: reason ?? null,
      };

      const applied = await store.revokeWithAudit(id, now, auditPayload);
      if (!applied) {
        // Race: another caller revoked between our SELECT and UPDATE.
        const afterRow = await store.findById(id);
        emit(ctx, {
          apiKeyId: id,
          applied: false,
          status: afterRow?.status ?? "revoked",
          revokedAt: afterRow?.revoked_at ?? null,
        });
        return undefined;
      }

      ctx.logger.info(
        {
          audit_id: auditId,
          audit_action: "keys.revoke",
          api_key_id: id,
          project_id: existing.project_id,
          environment: existing.environment,
          source_id: existing.source_id,
          previous_status: existing.status,
          new_status: "revoked",
          reason: reason ?? null,
          occurred_at: now.toISOString(),
        },
        "api key revoked (audit row persisted)",
      );

      emit(ctx, {
        apiKeyId: id,
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

const runKeysRevoke = buildKeysRevokeRunner();

function defaultStore(env: NodeJS.ProcessEnv): KeysRevokeStore {
  const handle = connectDb({ env });
  return {
    findById: (id) => findApiKeyById(handle.db, id),
    revokeWithAudit: async (id, revokedAt, audit) =>
      handle.db.transaction().execute(async (trx) => {
        const applied = await revokeApiKey(trx, id, revokedAt);
        if (!applied) return false;
        await insertAuditRecord(trx, {
          audit_id: audit.auditId,
          actor_source: audit.actorSource,
          actor_label: audit.actorLabel,
          action: "keys.revoke",
          target_type: "api_key",
          target_id: id,
          project_id: audit.projectId,
          environment: audit.environment,
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

function toSnapshot(row: ApiKeyRow): KeyAuditSnapshot {
  return {
    api_key_id: row.api_key_id,
    project_id: row.project_id,
    environment: row.environment,
    source_id: row.source_id,
    source_type: row.source_type,
    status: row.status,
    hash_algorithm: row.hash_algorithm,
    revoked_at: row.revoked_at,
  };
}

interface EmitInput {
  readonly apiKeyId: string;
  readonly applied: boolean;
  readonly status: string;
  readonly revokedAt: string | null;
}

function emit(ctx: CommandContext, input: EmitInput): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(input),
      json: {
        api_key_id: input.apiKeyId,
        applied: input.applied,
        status: input.status,
        revoked_at: input.revokedAt,
      },
    }),
  );
}

function renderHuman(input: EmitInput): string {
  if (input.applied) {
    return `revoked ${input.apiKeyId} at ${input.revokedAt}`;
  }
  return `${input.apiKeyId}: already revoked${
    input.revokedAt !== null ? ` at ${input.revokedAt}` : ""
  }`;
}
