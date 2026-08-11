/**
 * `polaris keys rotate <api_key_id>` — mutating.
 *
 * Issues a replacement key bound to the same
 * `(project_id, environment, source_id, source_type)` tuple as the existing
 * row and revokes the existing row in the same transaction. Per the
 * architecture decision (docs/architecture/02-control-plane.md "Rotation
 * policy"), there is NO grace period: the old key is unusable the moment
 * the rotation commits. If overlap is needed, operators run
 * `keys create` first, deploy, then `keys revoke` the original later.
 *
 * Steps:
 *
 *   1. SELECT the existing row. Reject if missing.
 *   2. Generate fresh material (`<id>.<secret>`).
 *   3. argon2id-hash the new secret through `@polaris/shared-secrets`.
 *   4. In one transaction: INSERT the new row + UPDATE the old to revoked
 *      + INSERT two audit rows (one `keys.rotate.issue` for the new row,
 *      one `keys.rotate.revoke` for the old row). All four writes go in
 *      one atomic unit.
 *   5. Print the new on-wire token EXACTLY ONCE.
 *
 * `mutates: true`. P6-007 gates this against production-without-token.
 *
 * @see docs/architecture/02-control-plane.md "Rotation policy"
 */
import { hashSecret, POLARIS_HASH_ALGORITHM } from "@polaris/shared-secrets";
import type { Command } from "commander";
import { v7 as uuidv7 } from "uuid";
import type { CommandContext, CommandDefinition } from "../../command.js";
import {
  type ApiKeyRow,
  type AuditActorSource,
  type AuditEnvironment,
  connectDb,
  findApiKeyById,
  type InsertApiKeyInput,
  rotateApiKeyWithAudit,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import type { KeyAuditSnapshot } from "./create.js";
import { generateKeyMaterial, type IssuedKeyMaterial } from "./token.js";

/**
 * Persistence surface used by `keys rotate`. Production wires this to a
 * Kysely transaction that INSERTs the new row, UPDATEs the old one, and
 * persists two audit rows atomically; tests inject an in-memory recorder
 * that performs all four writes on Maps.
 */
export interface KeysRotateStore {
  findById(apiKeyId: string): Promise<ApiKeyRow | null>;
  /**
   * Atomically insert the new row, revoke the old, and write both audit
   * rows. Implementations MUST ensure all four writes succeed or none
   * does.
   *
   * Returns `true` when the rotation transitioned the old row from
   * `'active'` to `'revoked'`. `false` signals a race (the old row was
   * already revoked by another caller during our transaction).
   */
  rotate(input: RotateStoreInput): Promise<boolean>;
  close(): Promise<void>;
}

export interface RotateStoreInput {
  readonly oldApiKeyId: string;
  readonly revokedAt: Date;
  readonly newRow: InsertApiKeyInput;
  readonly audit: KeysRotateAuditPayload;
}

export interface KeysRotateAuditPayload {
  readonly issueAuditId: string;
  readonly revokeAuditId: string;
  readonly actorSource: AuditActorSource;
  readonly actorLabel: string;
  readonly occurredAt: Date;
  readonly newKey: KeyAuditSnapshot;
  readonly oldKeyBefore: KeyAuditSnapshot;
  readonly oldKeyAfter: KeyAuditSnapshot;
  readonly projectId: string;
  readonly environment: AuditEnvironment;
}

/** Test hook surface (mirrors `keysCreateCommand`). */
export interface KeysRotateHooks {
  readonly issue?: () => IssuedKeyMaterial;
  readonly hash?: (plaintext: string) => Promise<string>;
  readonly openStore?: () => KeysRotateStore;
  readonly now?: () => Date;
  readonly generateAuditId?: () => string;
  readonly actorLabel?: () => string;
}

interface KeysRotateArgs {
  readonly apiKeyId: string;
}

export const keysRotateCommand: CommandDefinition = {
  id: "keys.rotate",
  mutates: true,
  register: (parent, deps) => {
    const cmd = parent
      .command("rotate <api_key_id>")
      .description(
        "Issue a replacement key and revoke the original. No grace period — the old key is unusable immediately.",
      );
    cmd.action(async (apiKeyId: string, _opts: unknown, command: Command) => {
      const wrapped = deps.runCommand<KeysRotateArgs>(
        { id: "keys.rotate", mutates: true },
        runKeysRotate,
      );
      await wrapped({ apiKeyId }, command);
    });
  },
};

/**
 * Build a `keys rotate` runner with overridable hooks (mirrors
 * `buildKeysCreateRunner`). Tests use this to inject deterministic ids and a
 * fake hash function so the suite does not pay the argon2 cost.
 */
export function buildKeysRotateRunner(hooks: KeysRotateHooks = {}) {
  const issueMaterial = hooks.issue ?? generateKeyMaterial;
  const hashFn = hooks.hash ?? hashSecret;
  const nowFn = hooks.now ?? (() => new Date());
  // Tests can inject a deterministic id sequence; production uses uuidv7.
  // We need two distinct ids per rotation, so we generate per-call.
  const generateAuditId = hooks.generateAuditId ?? uuidv7;
  const actorLabelOverride = hooks.actorLabel;

  return async function runner(args: KeysRotateArgs, ctx: CommandContext): Promise<undefined> {
    const openStore = hooks.openStore ?? (() => defaultStore(ctx.env));
    const id = args.apiKeyId.trim();
    if (id.length === 0) {
      throw new UsageError("api_key_id is required");
    }

    const store = openStore();
    try {
      const existing = await store.findById(id);
      if (existing === null) {
        throw new UsageError(`api key "${id}" not found`);
      }
      if (existing.status !== "active") {
        throw new UsageError(
          `api key "${id}" is ${existing.status}; rotate requires an active key. ` +
            "Use `polaris keys create` to issue a fresh key.",
        );
      }

      const material = issueMaterial();
      const hashed = await hashFn(material.rawSecret);
      const now = nowFn();
      const issueAuditId = generateAuditId();
      const revokeAuditId = generateAuditId();
      const newKey: KeyAuditSnapshot = {
        api_key_id: material.apiKeyId,
        project_id: existing.project_id,
        environment: existing.environment,
        source_id: existing.source_id,
        source_type: existing.source_type,
        status: "active",
        hash_algorithm: POLARIS_HASH_ALGORITHM,
        revoked_at: null,
      };
      const oldKeyBefore = toSnapshot(existing);
      const oldKeyAfter: KeyAuditSnapshot = {
        ...oldKeyBefore,
        status: "revoked",
        revoked_at: now.toISOString(),
      };

      const rotated = await store.rotate({
        oldApiKeyId: id,
        revokedAt: now,
        newRow: {
          api_key_id: material.apiKeyId,
          project_id: existing.project_id,
          environment: existing.environment,
          source_id: existing.source_id,
          source_type: existing.source_type,
          hash: hashed,
          hash_algorithm: POLARIS_HASH_ALGORITHM,
        },
        audit: {
          issueAuditId,
          revokeAuditId,
          actorSource: ctx.actor.source,
          actorLabel: actorLabelOverride?.() ?? ctx.actor.label,
          occurredAt: now,
          newKey,
          oldKeyBefore,
          oldKeyAfter,
          projectId: existing.project_id,
          environment: existing.environment as AuditEnvironment,
        },
      });
      if (!rotated) {
        throw new UsageError(
          `api key "${id}" was revoked by another caller during rotation. ` +
            "Retry `polaris keys rotate` after inspecting `polaris keys list`.",
        );
      }

      ctx.logger.info(
        {
          audit_id_issue: issueAuditId,
          audit_id_revoke: revokeAuditId,
          audit_action: "keys.rotate",
          old_api_key_id: id,
          new_api_key_id: material.apiKeyId,
          project_id: existing.project_id,
          environment: existing.environment,
          source_id: existing.source_id,
          occurred_at: now.toISOString(),
        },
        "api key rotated (issue + revoke audit rows persisted)",
      );

      emit(ctx, {
        oldApiKeyId: id,
        newApiKeyId: material.apiKeyId,
        token: material.token,
        projectId: existing.project_id,
        environment: existing.environment,
        sourceId: existing.source_id,
        sourceType: existing.source_type,
        revokedAt: now.toISOString(),
      });
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runKeysRotate = buildKeysRotateRunner();

function defaultStore(env: NodeJS.ProcessEnv): KeysRotateStore {
  const handle = connectDb({ env });
  return {
    findById: (id) => findApiKeyById(handle.db, id),
    rotate: async (input) => {
      const previous = await findApiKeyById(handle.db, input.oldApiKeyId);
      if (previous === null) return false;
      // INSERT new + UPDATE old + two audit rows, one transaction. A partial
      // failure cannot leave a live replacement paired with an unrevoked
      // original.
      await rotateApiKeyWithAudit(
        handle.db,
        { previous, replacement: input.newRow },
        {
          auditId: input.audit.issueAuditId,
          revokeAuditId: input.audit.revokeAuditId,
          actorSource: input.audit.actorSource,
          actorLabel: input.audit.actorLabel,
          occurredAt: input.revokedAt,
        },
      );
      return true;
    },
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
  readonly oldApiKeyId: string;
  readonly newApiKeyId: string;
  readonly token: string;
  readonly projectId: string;
  readonly environment: string;
  readonly sourceId: string;
  readonly sourceType: string;
  readonly revokedAt: string;
}

function emit(ctx: CommandContext, input: EmitInput): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(input),
      json: {
        old_api_key_id: input.oldApiKeyId,
        revoked_at: input.revokedAt,
        api_key_id: input.newApiKeyId,
        project_id: input.projectId,
        environment: input.environment,
        source_id: input.sourceId,
        source_type: input.sourceType,
        token: input.token,
      },
    }),
  );
}

function renderHuman(input: EmitInput): string {
  return [
    `polaris key rotated`,
    `  old api_key_id  ${input.oldApiKeyId} (revoked at ${input.revokedAt})`,
    `  new api_key_id  ${input.newApiKeyId}`,
    `  project_id      ${input.projectId}`,
    `  environment     ${input.environment}`,
    `  source_id       ${input.sourceId}`,
    `  source_type     ${input.sourceType}`,
    "",
    "New raw token (shown ONCE — store it now; the platform keeps only the hash):",
    `  ${input.token}`,
  ].join("\n");
}
