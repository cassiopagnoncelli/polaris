/**
 * `polaris export destinations --project <id> --env <env>` — read-only.
 *
 * Exports destination INSTANCE rows scoped to one `(project_id, environment)`
 * pair as JSON.
 *
 * **Hard rule: the export emits the `secret_ref` literal (`provider:ref`
 * form) but NEVER the resolved value.** The reference itself is safe to
 * print — it names where the secret lives, not what it is. The CLI never
 * resolves the secret at export time (or at any time outside the
 * destination consumer runtime).
 *
 * The destination row's column set does not include anything beyond the
 * `secret_ref` shape — no `secret_value`, no `password`, no `token`. Even
 * if a future migration added such a column, the export's allowlisted
 * shape below would skip it, and a dedicated redaction test would
 * surface the gap.
 *
 * `mutates: false`.
 */
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

const SUPPORTED_ENVIRONMENTS = ["development", "staging", "production"] as const;
type SupportedEnvironment = (typeof SUPPORTED_ENVIRONMENTS)[number];

export const exportDestinationsCommand: CommandDefinition = {
  id: "export.destinations",
  mutates: false,
  register: (parent, deps) => {
    parent
      .command("destinations")
      .description(
        "Export destination instances for one (project, environment) as JSON. Emits `secret_ref` literals only — never resolved secret values.",
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
  // (enforced by P6-004's schema-invariant test). The `secret_ref` is the
  // provider-namespaced reference, never the resolved value.
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
      secret_ref: row.secret_ref,
      status: row.status,
      mode: row.mode,
      max_concurrency: row.max_concurrency,
      max_rps: row.max_rps,
      retry_policy: row.retry_policy,
      dead_letter_threshold: row.dead_letter_threshold,
      disabled_reason: row.disabled_reason,
      // P7-004: replay-opt-in snapshot. Reference + flag only — no
      // resolved secret values appear in the export.
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
