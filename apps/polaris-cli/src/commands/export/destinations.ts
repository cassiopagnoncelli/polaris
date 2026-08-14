/**
 * `polaris export destinations --project <id> --env <env>` — read-only.
 *
 * Exports destination INSTANCE rows scoped to one `(project_id, environment)`
 * pair as JSON.
 *
 * **Hard rule: the export carries no credential.** It once emitted
 * `secret_ref`, and that was safe while the column named where a secret lived
 * rather than holding it. The column holds the credential now, and an export
 * is the worst possible carrier for one: a file, written to whatever path the
 * operator redirected to, easily mailed or committed.
 *
 * Two things enforce it. `DestinationRow` has no credential field, because
 * `listDestinationsByProjectEnv` does not select the column — so there is
 * nothing here to emit even by accident. And the allowlist below names every
 * field it writes, so a future migration adding a sensitive column does not
 * join the document by default.
 *
 * `mutates: false`.
 */

import { POLARIS_ENVIRONMENTS } from "@polaris/shared-environments";
import type { CommandContext, CommandDefinition } from "../../command.js";
import { connectDb, type DestinationRow, listDestinationsByProjectEnv } from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderJson } from "../../output.js";

interface ExportDestinationsArgs {
  readonly project?: string;
  readonly env?: string;
}

export interface ExportDestinationsStore {
  list(projectId: string, environment: string): Promise<readonly DestinationRow[]>;
  close(): Promise<void>;
}

export interface ExportDestinationsHooks {
  readonly openStore?: () => ExportDestinationsStore;
}

const SUPPORTED_ENVIRONMENTS = POLARIS_ENVIRONMENTS;
type SupportedEnvironment = (typeof SUPPORTED_ENVIRONMENTS)[number];

export const exportDestinationsCommand: CommandDefinition = {
  id: "export.destinations",
  mutates: false,
  register: (parent, deps) => {
    parent
      .command("destinations")
      .description(
        "Export destination instances for one (project, environment) as JSON. Operational columns only — never vendor credentials.",
      )
      .requiredOption("--project <project_id>", "Project to export destinations for.")
      .requiredOption("--env <environment>", "Environment: development | staging | production.")
      .action(
        deps.runCommand({ id: "export.destinations", mutates: false }, runExportDestinations),
      );
  },
};

export function buildExportDestinationsRunner(hooks: ExportDestinationsHooks = {}) {
  return async function runner(
    args: ExportDestinationsArgs,
    ctx: CommandContext,
  ): Promise<undefined> {
    const openStore = hooks.openStore ?? (() => defaultStore(ctx.env));
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

const runExportDestinations = buildExportDestinationsRunner();

function defaultStore(env: NodeJS.ProcessEnv): ExportDestinationsStore {
  const handle = connectDb({ env });
  return {
    list: (projectId, environment) =>
      listDestinationsByProjectEnv(handle.db, projectId, environment),
    close: () => handle.close(),
  };
}

interface ValidatedArgs {
  readonly project: string;
  readonly env: SupportedEnvironment;
}

function validate(args: ExportDestinationsArgs): ValidatedArgs {
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

function emit(ctx: CommandContext, args: ValidatedArgs, rows: readonly DestinationRow[]): void {
  // Strict allowlist of operational columns. Mapping semantics never
  // appear because the `DestinationsTable` schema has no such columns
  // (enforced by P6-004's schema-invariant test), and no credential appears
  // because `DestinationRow` does not carry one.
  const document = {
    project_id: args.project,
    environment: args.env,
    count: rows.length,
    destinations: rows.map((row) => ({
      destination_id: row.destination_id,
      project_id: row.project_id,
      environment: row.environment,
      vendor: row.vendor,
      instance_label: row.instance_label,
      status: row.status,
      mode: row.mode,
      max_concurrency: row.max_concurrency,
      max_rps: row.max_rps,
      retry_policy: row.retry_policy,
      dead_letter_threshold: row.dead_letter_threshold,
      disabled_reason: row.disabled_reason,
      // P7-004: replay-opt-in snapshot.
      replay_opt_in: row.replay_opt_in,
      replay_opt_in_reason: row.replay_opt_in_reason,
      replay_opt_in_at: row.replay_opt_in_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    })),
  };
  ctx.output.writeOut(renderJson(document));
}

function trim(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
