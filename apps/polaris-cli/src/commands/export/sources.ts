/**
 * `polaris export sources --project <id> --env <env>` — read-only.
 *
 * Emits a JSON document containing every source row scoped to one
 * `(project_id, environment)` pair. Source declarations are file-backed
 * (`catalog/sources/<project_id>/<source_id>.yaml`) — this export reads the
 * materialized PostgreSQL rows so an operator can diff what's actually in
 * the runtime against what the catalog declares.
 *
 * Source rows expose no secret-shaped fields (the migration's column set is
 * fully operator-readable), so no redaction is needed here.
 *
 * `mutates: false`.
 */

import type { SourceRow } from "../../catalog/sync.js";
import type { CommandContext, CommandDefinition } from "../../command.js";
import { connectDb, fetchSourcesByProject } from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderJson } from "../../output.js";

interface ExportSourcesArgs {
  readonly project?: string;
  readonly env?: string;
}

export interface ExportSourcesStore {
  list(projectId: string): Promise<readonly SourceRow[]>;
  close(): Promise<void>;
}

export interface ExportSourcesHooks {
  readonly openStore?: () => ExportSourcesStore;
}

const SUPPORTED_ENVIRONMENTS = ["development", "staging", "production"] as const;
type SupportedEnvironment = (typeof SUPPORTED_ENVIRONMENTS)[number];

export const exportSourcesCommand: CommandDefinition = {
  id: "export.sources",
  mutates: false,
  register: (parent, deps) => {
    parent
      .command("sources")
      .description(
        "Export sources for one (project, environment) as JSON. Reads the materialized PostgreSQL rows.",
      )
      .requiredOption("--project <project_id>", "Project to export sources for.")
      .requiredOption("--env <environment>", "Environment: development | staging | production.")
      .action(deps.runCommand({ id: "export.sources", mutates: false }, runExportSources));
  },
};

export function buildExportSourcesRunner(hooks: ExportSourcesHooks = {}) {
  return async function runner(args: ExportSourcesArgs, ctx: CommandContext): Promise<undefined> {
    const openStore = hooks.openStore ?? (() => defaultStore(ctx.env));
    const validated = validate(args);
    const store = openStore();
    try {
      const allRows = await store.list(validated.project);
      // Filter to sources whose `allowed_environments` includes the
      // requested env. The materialized row carries an array; we only emit
      // rows that are usable in the target environment so the export
      // matches "what is operational here?" rather than "what exists at
      // all?".
      const rows = allRows.filter((row) =>
        (row.allowed_environments as readonly string[]).includes(validated.env),
      );
      emit(ctx, validated, rows);
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runExportSources = buildExportSourcesRunner();

function defaultStore(env: NodeJS.ProcessEnv): ExportSourcesStore {
  const handle = connectDb({ env });
  return {
    list: (projectId) => fetchSourcesByProject(handle.db, projectId),
    close: () => handle.close(),
  };
}

interface ValidatedArgs {
  readonly project: string;
  readonly env: SupportedEnvironment;
}

function validate(args: ExportSourcesArgs): ValidatedArgs {
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

function emit(ctx: CommandContext, args: ValidatedArgs, rows: readonly SourceRow[]): void {
  // Export commands always emit JSON; the `--output human` form is a
  // pretty-printed JSON, which matches how operators typically pipe these
  // into other tools (`jq`, file capture, etc.). The shape is stable for
  // diffing.
  const document = {
    project_id: args.project,
    environment: args.env,
    count: rows.length,
    sources: rows.map((row) => ({
      project_id: row.project_id,
      source_id: row.source_id,
      source_type: row.source_type,
      owner: row.owner,
      description: row.description,
      runtime: row.runtime,
      allowed_environments: row.allowed_environments,
      status: row.status,
    })),
  };
  ctx.output.writeOut(renderJson(document));
}

function trim(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
