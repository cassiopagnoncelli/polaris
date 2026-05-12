/**
 * `polaris processors runs list` — read-only.
 *
 * Surfaces processor-run records when the `processor_runs` table exists.
 *
 * IMPORTANT: `processor_runs` is owned by P8-001 (Processor Runtime
 * Helpers), which is still in Ready. Until P8-001 lands the table and
 * schema, this command prints a structured message explaining that the
 * runtime helpers are not yet provisioned, AND returns exit 0 with an empty
 * result set (so scripts that pipe `polaris processors runs list` into
 * other tooling get a stable shape). Tests assert the command structure
 * but skip the SELECT side.
 *
 * The implementation is wired exactly the same way every other command in
 * the group is: parsed args -> `rejectProcessorRuleArguments` gate ->
 * store call -> render. Swapping the in-memory `notProvisioned()` stub for
 * a real Kysely-backed listing is a one-line change once the migration
 * lands.
 *
 * `mutates: false`: bypasses the production gate from P6-007.
 */
import type { CommandContext, CommandDefinition } from "../../command.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import { rejectProcessorRuleArguments } from "./validation.js";

interface ProcessorsRunsListArgs {
  readonly project?: string;
  readonly env?: string;
  readonly processor?: string;
  readonly version?: string;
}

/**
 * Stand-in for the future `processor_runs` repository. Production wires
 * this to `listProcessorRuns(...)` over Kysely once P8-001 ships the
 * migration. The shape exposes both the listing call and a structured
 * "not provisioned" probe so the command can render a polite message
 * instead of crashing.
 */
export interface ProcessorsRunsListStore {
  /**
   * Probe the `processor_runs` table. `null` means the table exists; a
   * `{ pendingTask, message }` object means the table is not yet
   * provisioned and the command should surface the message verbatim.
   */
  probe(): Promise<null | { pendingTask: string; message: string }>;
  /**
   * List run records matching the given scope. Only called when `probe()`
   * returns `null`. Implementations return ISO-stamped rows so JSON
   * output matches the human path.
   */
  list(scope: {
    project_id?: string;
    environment?: string;
    processor_name?: string;
    processor_version?: string;
  }): Promise<readonly ProcessorRunListRow[]>;
  close(): Promise<void>;
}

/**
 * Read-shape returned by the (future) `processor_runs` listing. Mirrors
 * the audit envelope in `docs/architecture/05-processors-and-replay.md`
 * "Processor Metadata".
 */
export interface ProcessorRunListRow {
  readonly run_id: string;
  readonly processor_name: string;
  readonly processor_version: string;
  readonly project_id: string;
  readonly environment: string;
  readonly status: string;
  readonly started_at: string;
  readonly finished_at: string | null;
}

export interface ProcessorsRunsListHooks {
  readonly openStore?: () => ProcessorsRunsListStore;
}

export const processorsRunsListCommand: CommandDefinition = {
  id: "processors.runs.list",
  mutates: false,
  register: (parent, deps) => {
    parent
      .command("list")
      .description(
        "List processor runs (filter with --project, --env, --processor, --version). " +
          "Surfaces a 'not yet provisioned' message until P8-001 lands the table.",
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

    const store = openStore();
    try {
      const probe = await store.probe();
      if (probe !== null) {
        ctx.output.writeErr(probe.message);
        ctx.output.writeOut(
          renderAccordingTo(ctx.config.output, {
            human: probe.message,
            json: {
              not_provisioned: true,
              pending_task: probe.pendingTask,
              message: probe.message,
              count: 0,
              rows: [],
            },
          }),
        );
        return undefined;
      }

      const rows = await store.list(scope);
      emit(ctx, scope, rows);
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runProcessorsRunsList = buildProcessorsRunsListRunner();

/**
 * Default store: hard-coded "not yet provisioned" probe. P8-001 will swap
 * this for a Kysely-backed listing.
 */
function defaultStore(): ProcessorsRunsListStore {
  return {
    probe: async () => ({
      pendingTask: "P8-001",
      message:
        "processor_runs table not yet provisioned — wired in P8-001 (Processor Runtime Helpers).",
    }),
    list: async () => {
      // Unreachable until P8-001 lands. If we ever do reach here, surface
      // a usage error so the operator notices the missing wiring rather
      // than getting a silent empty list.
      throw new UsageError(
        "processor_runs listing is not implemented in P6-005 — P8-001 must replace defaultStore() with a Kysely-backed listing.",
      );
    },
    close: async () => {},
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
    lines.push(
      `  ${row.run_id} ${row.processor_name} ${row.processor_version} project=${row.project_id} env=${row.environment} status=${row.status} started=${row.started_at} finished=${row.finished_at ?? "(running)"}`,
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
