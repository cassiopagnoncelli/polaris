/**
 * `polaris replay list [--status <s>] [--project <id>] [--env <env>]
 *   [--limit <n>]` — read-only.
 *
 * Lists replay-job rows ordered by `created_at DESC`. Without filters,
 * returns the most recent 50 rows; the migration's
 * `(status, created_at DESC)` and `(project_id, environment, created_at
 * DESC)` indexes back this path.
 *
 * `mutates: false`: bypasses the production gate from P6-007.
 *
 * Columns shown:
 *
 *   replay_job_id, project_id, environment, target, mode, status,
 *   window_from, window_to, created_at, created_by
 */
import type { CommandContext, CommandDefinition } from "../../command.js";
import {
  connectDb,
  type ListReplayJobsFilter,
  listReplayJobs,
  REPLAY_JOB_STATUSES,
  type ReplayJobRow,
  type ReplayJobStatus,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import { rejectReplayPlanArguments } from "./validation.js";

interface ReplayListArgs {
  readonly status?: string;
  readonly project?: string;
  readonly env?: string;
  readonly limit?: string;
}

export interface ReplayListStore {
  list(filter: ListReplayJobsFilter): Promise<readonly ReplayJobRow[]>;
  close(): Promise<void>;
}

export interface ReplayListHooks {
  readonly openStore?: () => ReplayListStore;
}

export const replayListCommand: CommandDefinition = {
  id: "replay.list",
  mutates: false,
  register: (parent, deps) => {
    parent
      .command("list")
      .description("List replay jobs. Newest first. Filter by --status, --project, --env, --limit.")
      .option("--status <status>", `Filter to one status: ${REPLAY_JOB_STATUSES.join(" | ")}.`)
      .option("--project <project_id>", "Filter to one project.")
      .option(
        "--env <environment>",
        "Filter to one environment: development | staging | production.",
      )
      .option("--limit <n>", "Maximum rows to return (default: 50, max: 500).")
      .action(deps.runCommand({ id: "replay.list", mutates: false }, runReplayList));
  },
};

export function buildReplayListRunner(hooks: ReplayListHooks = {}) {
  const openStore = hooks.openStore ?? defaultStore;

  return async function runner(args: ReplayListArgs, ctx: CommandContext): Promise<undefined> {
    rejectReplayPlanArguments(args as unknown as Record<string, unknown>);
    const filter = validate(args);

    const store = openStore();
    try {
      const rows = await store.list(filter);
      emit(ctx, filter, rows);
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runReplayList = buildReplayListRunner();

function defaultStore(): ReplayListStore {
  const handle = connectDb({ env: process.env });
  return {
    list: (filter) => listReplayJobs(handle.db, filter),
    close: () => handle.close(),
  };
}

function validate(args: ReplayListArgs): ListReplayJobsFilter {
  // Build the filter immutably so the readonly slots on
  // `ListReplayJobsFilter` are satisfied. Each optional input only contributes
  // to the spread when it parses cleanly.
  const filter: {
    status?: ReplayJobStatus;
    projectId?: string;
    environment?: string;
    limit?: number;
  } = {};

  const status = trim(args.status);
  if (status !== undefined) {
    if (!(REPLAY_JOB_STATUSES as readonly string[]).includes(status)) {
      throw new UsageError(
        `--status must be one of: ${REPLAY_JOB_STATUSES.join(", ")} (got "${status}")`,
      );
    }
    filter.status = status as ReplayJobStatus;
  }
  const project = trim(args.project);
  if (project !== undefined) filter.projectId = project;
  const environment = trim(args.env);
  if (environment !== undefined) {
    if (
      environment !== "development" &&
      environment !== "staging" &&
      environment !== "production"
    ) {
      throw new UsageError(
        `--env must be one of: development, staging, production (got "${environment}")`,
      );
    }
    filter.environment = environment;
  }
  if (args.limit !== undefined) {
    const limit = parsePositiveInt(args.limit, "--limit", 1, 500);
    if (limit !== undefined) filter.limit = limit;
  }
  return filter;
}

function parsePositiveInt(
  raw: string | undefined,
  flag: string,
  min: number,
  max: number,
): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (!/^[1-9][0-9]*$/.test(trimmed)) {
    throw new UsageError(`${flag} must be a positive integer (got "${trimmed}")`);
  }
  const value = Number.parseInt(trimmed, 10);
  if (value < min || value > max) {
    throw new UsageError(`${flag} must be between ${min} and ${max} (got ${value})`);
  }
  return value;
}

function trim(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

interface ListJsonRow {
  readonly replay_job_id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly target: string;
  readonly mode: string;
  readonly status: string;
  readonly window_from: string;
  readonly window_to: string;
  readonly created_at: string;
  readonly created_by: string;
}

function toJsonRow(row: ReplayJobRow): ListJsonRow {
  return {
    replay_job_id: row.replay_job_id,
    project_id: row.project_id,
    environment: row.environment,
    target: row.target,
    mode: row.mode,
    status: row.status,
    window_from: row.window_from,
    window_to: row.window_to,
    created_at: row.created_at,
    created_by: row.created_by,
  };
}

function emit(
  ctx: CommandContext,
  filter: ListReplayJobsFilter,
  rows: readonly ReplayJobRow[],
): void {
  const view = rows.map(toJsonRow);
  const filterJson = describeFilterJson(filter);
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(filter, view),
      json: { filter: filterJson, count: view.length, rows: view },
    }),
  );
}

function describeFilterJson(filter: ListReplayJobsFilter): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (filter.status !== undefined) out["status"] = filter.status;
  if (filter.projectId !== undefined) out["project_id"] = filter.projectId;
  if (filter.environment !== undefined) out["environment"] = filter.environment;
  if (filter.limit !== undefined) out["limit"] = filter.limit;
  return Object.keys(out).length === 0 ? null : out;
}

function describeFilterHuman(filter: ListReplayJobsFilter): string {
  const parts: string[] = [];
  if (filter.status !== undefined) parts.push(`status=${filter.status}`);
  if (filter.projectId !== undefined) parts.push(`project=${filter.projectId}`);
  if (filter.environment !== undefined) parts.push(`env=${filter.environment}`);
  if (filter.limit !== undefined) parts.push(`limit=${filter.limit}`);
  return parts.join(" ");
}

function renderHuman(filter: ListReplayJobsFilter, rows: readonly ListJsonRow[]): string {
  const scope = describeFilterHuman(filter);
  if (rows.length === 0) {
    return `(no replay jobs${scope === "" ? "" : ` for ${scope}`})`;
  }
  const header = `count=${rows.length}${scope === "" ? "" : ` ${scope}`}`;
  const lines: string[] = [header];
  for (const row of rows) {
    lines.push(
      `  ${row.replay_job_id} project=${row.project_id} env=${row.environment} target=${row.target} mode=${row.mode} status=${row.status} window=${row.window_from}..${row.window_to} created_at=${row.created_at} by=${row.created_by}`,
    );
  }
  return lines.join("\n");
}
