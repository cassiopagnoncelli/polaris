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
 *   4. In one transaction: INSERT the new row + UPDATE the old to revoked.
 *   5. Print the new on-wire token EXACTLY ONCE.
 *
 * `mutates: true`. P6-007 gates this against production-without-token.
 *
 * @see docs/architecture/02-control-plane.md "Rotation policy"
 */
import { hashSecret, POLARIS_HASH_ALGORITHM } from "@polaris/shared-secrets";
import type { Command } from "commander";
import type { CommandContext, CommandDefinition } from "../../command.js";
import {
  type ApiKeyRow,
  connectDb,
  findApiKeyById,
  insertApiKey,
  type InsertApiKeyInput,
  revokeApiKey,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import { generateKeyMaterial, type IssuedKeyMaterial } from "./token.js";

/**
 * Persistence surface used by `keys rotate`. Production wires this to a
 * Kysely transaction that INSERTs the new row and UPDATEs the old one
 * atomically; tests inject an in-memory recorder that performs the same
 * INSERT+UPDATE on a Map.
 */
export interface KeysRotateStore {
  findById(apiKeyId: string): Promise<ApiKeyRow | null>;
  /**
   * Atomically insert the new row and revoke the old. Implementations MUST
   * ensure either both writes succeed or neither does — a partial failure
   * would leave the system with both keys active or both revoked.
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
}

/** Test hook surface (mirrors `keysCreateCommand`). */
export interface KeysRotateHooks {
  readonly issue?: () => IssuedKeyMaterial;
  readonly hash?: (plaintext: string) => Promise<string>;
  readonly openStore?: () => KeysRotateStore;
  readonly now?: () => Date;
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
  const openStore = hooks.openStore ?? defaultStore;
  const nowFn = hooks.now ?? (() => new Date());

  return async function runner(args: KeysRotateArgs, ctx: CommandContext): Promise<undefined> {
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
      });
      if (!rotated) {
        // The pre-check confirmed the row was active. If the rotation
        // returned false, someone else revoked between our SELECT and the
        // transaction's UPDATE — surface a usage error so the caller sees
        // the race rather than silently issuing an orphan new key.
        throw new UsageError(
          `api key "${id}" was revoked by another caller during rotation. ` +
            "Retry `polaris keys rotate` after inspecting `polaris keys list`.",
        );
      }

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

function defaultStore(): KeysRotateStore {
  const handle = connectDb({ env: process.env });
  return {
    findById: (id) => findApiKeyById(handle.db, id),
    rotate: (input) =>
      handle.db.transaction().execute(async (trx) => {
        // INSERT new + UPDATE old in one transaction so a partial failure
        // cannot leave the system with both keys active or both revoked.
        await insertApiKey(trx, input.newRow);
        return revokeApiKey(trx, input.oldApiKeyId, input.revokedAt);
      }),
    close: () => handle.close(),
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
        // Single write of the on-wire plaintext. Same one-time rule as
        // `keys create`.
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
