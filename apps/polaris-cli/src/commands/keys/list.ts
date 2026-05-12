/**
 * `polaris keys list --project <id> --env <env>` — read-only.
 *
 * Lists API keys scoped to one `(project_id, environment)` pair. Includes
 * revoked rows so operators can see the full lifecycle (issue -> revoke ->
 * rotate). Columns:
 *
 *   api_key_id, source_id, source_type, status, created_at, last_used_at,
 *   revoked_at
 *
 * The raw token plaintext NEVER appears in this output: only the public
 * `api_key_id` prefix. The `hash` column is excluded from the SQL select on
 * purpose — listing PHC strings would leak nothing exploitable but invites
 * accidental log capture, so we just don't fetch them.
 *
 * `mutates: false`: bypasses the production gate from P6-007.
 */
import type { CommandContext, CommandDefinition } from "../../command.js";
import { connectDb, listApiKeysByProjectEnv, type ApiKeyRow } from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";

interface KeysListArgs {
  readonly project?: string;
  readonly env?: string;
}

/**
 * Persistence surface used by `keys list`. Production wires this to
 * `listApiKeysByProjectEnv` over a Kysely client; tests inject an in-memory
 * recorder. The store deliberately omits the `hash` column from its return
 * type so no renderer path can ever surface it.
 */
export interface KeysListStore {
  list(projectId: string, environment: string): Promise<readonly ApiKeyRow[]>;
  close(): Promise<void>;
}

export interface KeysListHooks {
  readonly openStore?: () => KeysListStore;
}

export const keysListCommand: CommandDefinition = {
  id: "keys.list",
  mutates: false,
  register: (parent, deps) => {
    parent
      .command("list")
      .description("List API keys for a (project, environment). Never displays the raw token.")
      .requiredOption("--project <project_id>", "Project to list keys for.")
      .requiredOption("--env <environment>", "Environment: development | staging | production.")
      .action(deps.runCommand({ id: "keys.list", mutates: false }, runKeysList));
  },
};

export function buildKeysListRunner(hooks: KeysListHooks = {}) {
  const openStore = hooks.openStore ?? defaultStore;

  return async function runner(args: KeysListArgs, ctx: CommandContext): Promise<undefined> {
    const project = trim(args.project);
    const env = trim(args.env);
    if (project === undefined) {
      throw new UsageError("--project is required");
    }
    if (env === undefined) {
      throw new UsageError("--env is required");
    }

    const store = openStore();
    try {
      const rows = await store.list(project, env);
      emit(ctx, project, env, rows);
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runKeysList = buildKeysListRunner();

function defaultStore(): KeysListStore {
  const handle = connectDb({ env: process.env });
  return {
    list: (projectId, environment) => listApiKeysByProjectEnv(handle.db, projectId, environment),
    close: () => handle.close(),
  };
}

function emit(
  ctx: CommandContext,
  projectId: string,
  environment: string,
  rows: readonly ApiKeyRow[],
): void {
  // The view explicitly omits `hash` so the renderer can't ever surface it.
  const view = rows.map(toView);
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(projectId, environment, view),
      json: {
        project_id: projectId,
        environment,
        count: view.length,
        rows: view,
      },
    }),
  );
}

interface ApiKeyListView {
  readonly api_key_id: string;
  readonly source_id: string;
  readonly source_type: string;
  readonly status: string;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
}

function toView(row: ApiKeyRow): ApiKeyListView {
  return {
    api_key_id: row.api_key_id,
    source_id: row.source_id,
    source_type: row.source_type,
    status: row.status,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
  };
}

function renderHuman(
  projectId: string,
  environment: string,
  rows: readonly ApiKeyListView[],
): string {
  if (rows.length === 0) {
    return `(no api keys for project=${projectId} env=${environment})`;
  }
  const lines: string[] = [`project=${projectId} env=${environment} count=${rows.length}`];
  for (const row of rows) {
    const last = row.last_used_at ?? "(unused)";
    const revoked = row.revoked_at === null ? "" : ` revoked=${row.revoked_at}`;
    lines.push(
      `  ${row.api_key_id} source=${row.source_id} type=${row.source_type} status=${row.status} created=${row.created_at} last_used=${last}${revoked}`,
    );
  }
  return lines.join("\n");
}

function trim(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
