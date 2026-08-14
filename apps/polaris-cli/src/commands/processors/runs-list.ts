/**
 * `polaris processors runs list` — read-only.
 *
 * Lists rows of `processor_runs`: which processor version ran, on which host,
 * since when, and how it ended. The rows are written by the processors
 * themselves at boot, through `@polaris/shared-processor`'s
 * `openProcessorRun`; this command only reads them.
 *
 * A run row is what an emitted event's `processor.run_id` points at, so this
 * is the command that turns a derived event back into the process that
 * produced it.
 *
 * Empty output means no processor has started since run recording landed —
 * not that the feature is missing.
 *
 * `mutates: false`: bypasses the production gate from P6-007.
 */
import type { CommandContext, CommandDefinition } from "../../command.js";
import { connectDb, listProcessorRuns, type ProcessorRunScope } from "../../db/index.js";
import { renderAccordingTo } from "../../output.js";
import { rejectProcessorRuleArguments } from "./validation.js";

/** Rows returned by one `runs list` call. Matches the admin panel's page size. */
const DEFAULT_LIMIT = 50;

interface ProcessorsRunsListArgs {
  readonly project?: string;
  readonly env?: string;
  readonly processor?: string;
  readonly version?: string;
}

/** Storage seam. Tests inject an in-memory listing; production is Kysely. */
export interface ProcessorsRunsListStore {
  /**
   * List run records matching the given scope. Implementations return
   * ISO-stamped rows so JSON output matches the human path.
   */
  list(scope: ProcessorRunScope): Promise<readonly ProcessorRunListRow[]>;
  close(): Promise<void>;
}

/**
 * Read-shape rendered by this command. Mirrors the run envelope in
 * `docs/architecture/05-processors-and-replay.md` "Processor Metadata".
 *
 * `project_id` / `environment` are nullable: a processor consuming the shared
 * stream registers a cross-project run, and a deployment whose environment
 * label is outside the control plane's three environments records unscoped.
 */
export interface ProcessorRunListRow {
  readonly run_id: string;
  readonly processor_name: string;
  readonly processor_version: string;
  readonly project_id: string | null;
  readonly environment: string | null;
  readonly status: string;
  readonly started_at: string;
  readonly finished_at: string | null;
}

export interface ProcessorsRunsListHooks {
  readonly openStore?: (env: NodeJS.ProcessEnv) => ProcessorsRunsListStore;
}

export const processorsRunsListCommand: CommandDefinition = {
  id: "processors.runs.list",
  mutates: false,
  register: (parent, deps) => {
    parent
      .command("list")
      .description(
        "List processor runs — what actually ran, as opposed to what is activated " +
          "(filter with --project, --env, --processor, --version).",
      )
      .option("--project <project_id>", "Filter results to one project.")
      .option(
        "--env <environment>",
        "Filter results to one environment: development | staging | production.",
      )
      .option("--processor <name>", "Filter results to one processor name.")
      .option("--version <version>", "Filter results to one processor version (e.g. v1).")
      .action(
        deps.runCommand({ id: "processors.runs.list", mutates: false }, runProcessorsRunsList),
      );
  },
};

export function buildProcessorsRunsListRunner(hooks: ProcessorsRunsListHooks = {}) {
  const openStore = hooks.openStore ?? defaultStore;

  return async function runner(
    args: ProcessorsRunsListArgs,
    ctx: CommandContext,
  ): Promise<undefined> {
    rejectProcessorRuleArguments(args as unknown as Record<string, unknown>);

    const scope = {
      ...(trim(args.project) !== undefined ? { project_id: trim(args.project) as string } : {}),
      ...(trim(args.env) !== undefined ? { environment: trim(args.env) as string } : {}),
      ...(trim(args.processor) !== undefined
        ? { processor_name: trim(args.processor) as string }
        : {}),
      ...(trim(args.version) !== undefined
        ? { processor_version: trim(args.version) as string }
        : {}),
    };

    const store = openStore(ctx.env);
    try {
      const rows = await store.list(scope);
      emit(ctx, scope, rows);
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runProcessorsRunsList = buildProcessorsRunsListRunner();

function defaultStore(env: NodeJS.ProcessEnv): ProcessorsRunsListStore {
  // `connectDb({ env })`, not `connectDb()`: command.ts states the MUST —
  // reading process.env directly leaks the developer's real environment
  // into tests meaning to exercise the "no var set" path. These two were
  // the only call sites of 56 that omitted it.
  const handle = connectDb({ env });
  return {
    list: (scope) => listProcessorRuns(handle.db, scope, DEFAULT_LIMIT),
    close: () => handle.close(),
  };
}

function emit(
  ctx: CommandContext,
  scope: {
    project_id?: string;
    environment?: string;
    processor_name?: string;
    processor_version?: string;
  },
  rows: readonly ProcessorRunListRow[],
): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(scope, rows),
      json: {
        scope: Object.keys(scope).length === 0 ? null : scope,
        count: rows.length,
        rows,
      },
    }),
  );
}

function renderHuman(
  scope: {
    project_id?: string;
    environment?: string;
    processor_name?: string;
    processor_version?: string;
  },
  rows: readonly ProcessorRunListRow[],
): string {
  const filter = describeScope(scope);
  if (rows.length === 0) {
    return `(no processor runs${filter === "" ? "" : ` for ${filter}`})`;
  }
  const lines: string[] = [`count=${rows.length}${filter === "" ? "" : ` ${filter}`}`];
  for (const row of rows) {
    // Null scope is the normal case, not missing data: processors consume the
    // shared stream cross-project. Say that rather than printing "null".
    const project = row.project_id ?? "(cross-project)";
    const environment = row.environment ?? "(unscoped)";
    lines.push(
      `  ${row.run_id} ${row.processor_name} ${row.processor_version} project=${project} env=${environment} status=${row.status} started=${row.started_at} finished=${row.finished_at ?? "(running)"}`,
    );
  }
  return lines.join("\n");
}

function describeScope(scope: {
  project_id?: string;
  environment?: string;
  processor_name?: string;
  processor_version?: string;
}): string {
  const parts: string[] = [];
  if (scope.project_id !== undefined) parts.push(`project=${scope.project_id}`);
  if (scope.environment !== undefined) parts.push(`env=${scope.environment}`);
  if (scope.processor_name !== undefined) parts.push(`processor=${scope.processor_name}`);
  if (scope.processor_version !== undefined) parts.push(`version=${scope.processor_version}`);
  return parts.join(" ");
}

function trim(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
