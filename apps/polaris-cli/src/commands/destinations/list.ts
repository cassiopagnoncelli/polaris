/**
 * `polaris destinations list [--project <id>] [--env <env>]` — read-only.
 *
 * Lists destination instances. Without flags, returns every row. With
 * `--project` and `--env`, scoped to one tuple. With only one of the two,
 * filters the broader list.
 *
 * Columns:
 *
 *   destination_id, project_id, environment, vendor, instance_label,
 *   status, mode, max_concurrency, max_rps
 *
 * `mutates: false`: bypasses the production gate from P6-007.
 */
import type { CommandContext, CommandDefinition } from "../../command.js";
import {
  type DestinationRow,
  connectDb,
  listAllDestinations,
  listDestinationsByProjectEnv,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import { rejectMappingArguments } from "./validation.js";

interface DestinationsListArgs {
  readonly project?: string;
  readonly env?: string;
}

export interface DestinationsListStore {
  list(filter: { projectId?: string; environment?: string }): Promise<readonly DestinationRow[]>;
  close(): Promise<void>;
}

export interface DestinationsListHooks {
  readonly openStore?: () => DestinationsListStore;
}

export const destinationsListCommand: CommandDefinition = {
  id: "destinations.list",
  mutates: false,
  register: (parent, deps) => {
    parent
      .command("list")
      .description("List destination instances (filter with --project and/or --env).")
      .option("--project <project_id>", "Filter results to one project.")
      .option(
        "--env <environment>",
        "Filter results to one environment: development | staging | production.",
      )
      .action(deps.runCommand({ id: "destinations.list", mutates: false }, runDestinationsList));
  },
};

export function buildDestinationsListRunner(hooks: DestinationsListHooks = {}) {
  const openStore = hooks.openStore ?? defaultStore;

  return async function runner(
    args: DestinationsListArgs,
    ctx: CommandContext,
  ): Promise<undefined> {
    rejectMappingArguments(args as unknown as Record<string, unknown>);
    const projectId = trim(args.project);
    const environment = trim(args.env);
    if (environment !== undefined && !isSupportedEnv(environment)) {
      throw new UsageError(
        `--env must be one of: development, staging, production (got "${environment}")`,
      );
    }

    const store = openStore();
    try {
      const filter: { projectId?: string; environment?: string } = {};
      if (projectId !== undefined) filter.projectId = projectId;
      if (environment !== undefined) filter.environment = environment;
      const rows = await store.list(filter);
      emit(ctx, filter, rows);
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runDestinationsList = buildDestinationsListRunner();

function defaultStore(): DestinationsListStore {
  const handle = connectDb({ env: process.env });
  return {
    list: async (filter) => {
      if (filter.projectId !== undefined && filter.environment !== undefined) {
        return listDestinationsByProjectEnv(handle.db, filter.projectId, filter.environment);
      }
      const rows = await listAllDestinations(handle.db);
      return rows.filter((row) => {
        if (filter.projectId !== undefined && row.project_id !== filter.projectId) return false;
        if (filter.environment !== undefined && row.environment !== filter.environment) {
          return false;
        }
        return true;
      });
    },
    close: () => handle.close(),
  };
}

interface DestinationView {
  readonly destination_id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly vendor: string;
  readonly instance_label: string;
  readonly status: string;
  readonly mode: string;
  readonly max_concurrency: number;
  readonly max_rps: number;
  readonly retry_policy: string;
  readonly dead_letter_threshold: number;
}

function toView(row: DestinationRow): DestinationView {
  return {
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
  };
}

function emit(
  ctx: CommandContext,
  filter: { projectId?: string; environment?: string },
  rows: readonly DestinationRow[],
): void {
  const view = rows.map(toView);
  const filterJson =
    filter.projectId !== undefined || filter.environment !== undefined
      ? {
          ...(filter.projectId !== undefined ? { project_id: filter.projectId } : {}),
          ...(filter.environment !== undefined ? { environment: filter.environment } : {}),
        }
      : null;
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(filter, view),
      json: { filter: filterJson, count: view.length, rows: view },
    }),
  );
}

function renderHuman(
  filter: { projectId?: string; environment?: string },
  rows: readonly DestinationView[],
): string {
  const scope = describeFilter(filter);
  if (rows.length === 0) {
    return `(no destinations${scope === "" ? "" : ` for ${scope}`})`;
  }
  const header = `count=${rows.length}${scope === "" ? "" : ` ${scope}`}`;
  const lines: string[] = [header];
  for (const row of rows) {
    lines.push(
      `  ${row.destination_id} vendor=${row.vendor} label=${row.instance_label} project=${row.project_id} env=${row.environment} status=${row.status} mode=${row.mode} concurrency=${row.max_concurrency} rps=${row.max_rps}`,
    );
  }
  return lines.join("\n");
}

function describeFilter(filter: { projectId?: string; environment?: string }): string {
  const parts: string[] = [];
  if (filter.projectId !== undefined) parts.push(`project=${filter.projectId}`);
  if (filter.environment !== undefined) parts.push(`env=${filter.environment}`);
  return parts.join(" ");
}

function trim(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function isSupportedEnv(value: string): boolean {
  return value === "development" || value === "staging" || value === "production";
}
