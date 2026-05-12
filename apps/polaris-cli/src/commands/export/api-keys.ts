/**
 * `polaris export api-keys --project <id> --env <env>` — read-only.
 *
 * Exports API key METADATA scoped to one `(project_id, environment)` pair.
 *
 * **Hard rule: the export NEVER includes the argon2id `hash` column or any
 * on-wire plaintext token.** The repository helper
 * (`listApiKeysByProjectEnv`) does not even SELECT the `hash` column, so
 * the data simply is not on the path. The shape emitted here is a strict
 * allowlist of the metadata columns. Adding a `hash`-shaped key here would
 * fail the test that pins the export shape, and the upstream SELECT would
 * not return the value anyway.
 *
 * Operators use this export to:
 *   - audit which keys exist in which (project, env)
 *   - diff between environments after a key rotation
 *   - confirm a revocation propagated to PostgreSQL
 *
 * `mutates: false`.
 */
import type { CommandContext, CommandDefinition } from "../../command.js";
import { type ApiKeyRow, connectDb, listApiKeysByProjectEnv } from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderJson } from "../../output.js";

interface ExportApiKeysArgs {
  readonly project?: string;
  readonly env?: string;
}

export interface ExportApiKeysStore {
  list(projectId: string, environment: string): Promise<readonly ApiKeyRow[]>;
  close(): Promise<void>;
}

export interface ExportApiKeysHooks {
  readonly openStore?: () => ExportApiKeysStore;
}

const SUPPORTED_ENVIRONMENTS = ["development", "staging", "production"] as const;
type SupportedEnvironment = (typeof SUPPORTED_ENVIRONMENTS)[number];

export const exportApiKeysCommand: CommandDefinition = {
  id: "export.api-keys",
  mutates: false,
  register: (parent, deps) => {
    parent
      .command("api-keys")
      .description(
        "Export API key metadata for one (project, environment) as JSON. Never includes the argon2id hash or plaintext token.",
      )
      .requiredOption("--project <project_id>", "Project to export keys for.")
      .requiredOption("--env <environment>", "Environment: development | staging | production.")
      .action(deps.runCommand({ id: "export.api-keys", mutates: false }, runExportApiKeys));
  },
};

export function buildExportApiKeysRunner(hooks: ExportApiKeysHooks = {}) {
  const openStore = hooks.openStore ?? defaultStore;

  return async function runner(args: ExportApiKeysArgs, ctx: CommandContext): Promise<undefined> {
    const validated = validate(args);
    const store = openStore();
    try {
      const rows = await store.list(validated.project, validated.env);
      emit(ctx, validated, rows);
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runExportApiKeys = buildExportApiKeysRunner();

function defaultStore(): ExportApiKeysStore {
  const handle = connectDb({ env: process.env });
  return {
    list: (projectId, environment) => listApiKeysByProjectEnv(handle.db, projectId, environment),
    close: () => handle.close(),
  };
}

interface ValidatedArgs {
  readonly project: string;
  readonly env: SupportedEnvironment;
}

function validate(args: ExportApiKeysArgs): ValidatedArgs {
  const project = trim(args.project);
  const env = trim(args.env);
  if (project === undefined) throw new UsageError("--project is required");
  if (env === undefined) throw new UsageError("--env is required");
  if (!(SUPPORTED_ENVIRONMENTS as ReadonlyArray<string>).includes(env)) {
    throw new UsageError(
      `--env must be one of: ${SUPPORTED_ENVIRONMENTS.join(", ")} (got "${env}")`,
    );
  }
  return { project, env: env as SupportedEnvironment };
}

function emit(ctx: CommandContext, args: ValidatedArgs, rows: readonly ApiKeyRow[]): void {
  // Strict allowlist of metadata columns. The `hash` column is not present
  // on `ApiKeyRow` (the repository's SELECT omits it), so this filter is
  // belt-and-braces: even if a future change added `hash` to the row, the
  // mapped shape below would still skip it. Adding a `hash` key here would
  // fail the dedicated export-redaction test.
  const document = {
    project_id: args.project,
    environment: args.env,
    count: rows.length,
    api_keys: rows.map((row) => ({
      api_key_id: row.api_key_id,
      project_id: row.project_id,
      environment: row.environment,
      source_id: row.source_id,
      source_type: row.source_type,
      status: row.status,
      hash_algorithm: row.hash_algorithm,
      created_at: row.created_at,
      revoked_at: row.revoked_at,
      last_used_at: row.last_used_at,
    })),
  };
  ctx.output.writeOut(renderJson(document));
}

function trim(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
