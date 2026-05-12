/**
 * `polaris keys revoke <api_key_id>` — mutating.
 *
 * Sets `status='revoked'` and stamps `revoked_at` on the row. The operation
 * is idempotent: running it twice is not an error. The CLI prints
 * "already revoked" on the second call and exits 0 so scripts can re-run
 * without bracketing each call in a try/catch.
 *
 * The ingester treats any non-`'active'` row as not-usable; revocation takes
 * effect on the next request that misses the auth cache (default TTL: 60s).
 *
 * `mutates: true`. P6-007 gates this against production-without-token.
 */
import type { Command } from "commander";
import type { CommandContext, CommandDefinition } from "../../command.js";
import { type ApiKeyRow, connectDb, findApiKeyById, revokeApiKey } from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";

interface KeysRevokeArgs {
  readonly apiKeyId: string;
}

/**
 * Persistence surface used by `keys revoke`. Production wires this to
 * `findApiKeyById` / `revokeApiKey` over a Kysely client; tests inject an
 * in-memory recorder.
 */
export interface KeysRevokeStore {
  findById(apiKeyId: string): Promise<ApiKeyRow | null>;
  revoke(apiKeyId: string, revokedAt: Date): Promise<boolean>;
  close(): Promise<void>;
}

export interface KeysRevokeHooks {
  readonly openStore?: () => KeysRevokeStore;
  readonly now?: () => Date;
}

export const keysRevokeCommand: CommandDefinition = {
  id: "keys.revoke",
  mutates: true,
  register: (parent, deps) => {
    const cmd = parent
      .command("revoke <api_key_id>")
      .description(
        "Revoke an API key. Idempotent: re-running on a revoked key prints `already revoked` and exits 0.",
      );
    cmd.action(async (apiKeyId: string, _opts: unknown, command: Command) => {
      const wrapped = deps.runCommand<KeysRevokeArgs>(
        { id: "keys.revoke", mutates: true },
        runKeysRevoke,
      );
      await wrapped({ apiKeyId }, command);
    });
  },
};

export function buildKeysRevokeRunner(hooks: KeysRevokeHooks = {}) {
  const openStore = hooks.openStore ?? defaultStore;
  const nowFn = hooks.now ?? (() => new Date());

  return async function runner(args: KeysRevokeArgs, ctx: CommandContext): Promise<undefined> {
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
        // Idempotent path: row is already revoked (or in any future
        // non-active state). We don't UPDATE because doing so would risk
        // overwriting the original `revoked_at` and lose audit-style
        // information.
        emit(ctx, {
          apiKeyId: id,
          applied: false,
          status: existing.status,
          revokedAt: existing.revoked_at,
        });
        return undefined;
      }

      const now = nowFn();
      const applied = await store.revoke(id, now);
      if (!applied) {
        // Race: another caller revoked between our SELECT and UPDATE.
        // Surface the same idempotent shape — the final state is `revoked`.
        const after = await store.findById(id);
        emit(ctx, {
          apiKeyId: id,
          applied: false,
          status: after?.status ?? "revoked",
          revokedAt: after?.revoked_at ?? null,
        });
        return undefined;
      }
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

function defaultStore(): KeysRevokeStore {
  const handle = connectDb({ env: process.env });
  return {
    findById: (id) => findApiKeyById(handle.db, id),
    revoke: (id, revokedAt) => revokeApiKey(handle.db, id, revokedAt),
    close: () => handle.close(),
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
