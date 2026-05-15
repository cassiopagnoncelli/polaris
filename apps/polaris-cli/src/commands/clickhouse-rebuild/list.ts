/**
 * `polaris clickhouse-rebuild list [--status <s>]
 *   [--projection <name>] [--limit <n>]` — read-only.
 *
 * Lists rebuild-job rows ordered by `created_at DESC`. Default limit
 * 50; the migration's `(status, created_at DESC)` and
 * `(target_projection, created_at DESC)` indexes back this path.
 *
 * `mutates: false`: bypasses the production gate from P6-007.
 */
import type { CommandContext, CommandDefinition } from "../../command.js";
import {
  CLICKHOUSE_REBUILD_JOB_STATUSES,
  type ClickhouseRebuildJobRow,
  type ClickhouseRebuildJobStatus,
  connectDb,
  type ListClickhouseRebuildJobsFilter,
  listClickhouseRebuildJobs,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";

interface ClickhouseRebuildListArgs {
  readonly status?: string;
  readonly projection?: string;
  readonly limit?: string;
}

export interface ClickhouseRebuildListStore {
  list(filter: ListClickhouseRebuildJobsFilter): Promise<readonly ClickhouseRebuildJobRow[]>;
  close(): Promise<void>;
}

export interface ClickhouseRebuildListHooks {
  readonly openStore?: () => ClickhouseRebuildListStore;
}

export const clickhouseRebuildListCommand: CommandDefinition = {
  id: "clickhouse-rebuild.list",
  mutates: false,
  register: (parent, deps) => {
    parent
      .command("list")
      .description(
        "List ClickHouse rebuild jobs. Newest first. Filter by --status, --projection, --limit.",
      )
      .option(
        "--status <status>",
        `Filter to one status: ${CLICKHOUSE_REBUILD_JOB_STATUSES.join(" | ")}.`,
      )
      .option("--projection <name>", "Filter to one projection.")
      .option("--limit <n>", "Maximum rows to return (default: 50, max: 500).")
      .action(deps.runCommand({ id: "clickhouse-rebuild.list", mutates: false }, runList));
  },
};

export function buildClickhouseRebuildListRunner(hooks: ClickhouseRebuildListHooks = {}) {
  const openStore = hooks.openStore ?? defaultStore;

  return async function runner(
    args: ClickhouseRebuildListArgs,
    ctx: CommandContext,
  ): Promise<undefined> {
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

const runList = buildClickhouseRebuildListRunner();

function defaultStore(): ClickhouseRebuildListStore {
  const handle = connectDb({ env: process.env });
  return {
    list: (filter) => listClickhouseRebuildJobs(handle.db, filter),
    close: () => handle.close(),
  };
}

function validate(args: ClickhouseRebuildListArgs): ListClickhouseRebuildJobsFilter {
  const filter: { status?: ClickhouseRebuildJobStatus; projection?: string; limit?: number } = {};
  const status = trim(args.status);
  if (status !== undefined) {
    if (!(CLICKHOUSE_REBUILD_JOB_STATUSES as readonly string[]).includes(status)) {
      throw new UsageError(
        `--status must be one of: ${CLICKHOUSE_REBUILD_JOB_STATUSES.join(", ")} (got "${status}")`,
      );
    }
    filter.status = status as ClickhouseRebuildJobStatus;
  }
  const projection = trim(args.projection);
  if (projection !== undefined) filter.projection = projection;
  if (args.limit !== undefined) {
    const trimmed = args.limit.trim();
    if (trimmed.length === 0) {
      // no-op
    } else if (!/^[1-9][0-9]*$/.test(trimmed)) {
      throw new UsageError(`--limit must be a positive integer (got "${trimmed}")`);
    } else {
      const value = Number.parseInt(trimmed, 10);
      if (value < 1 || value > 500) {
        throw new UsageError(`--limit must be between 1 and 500 (got ${value})`);
      }
      filter.limit = value;
    }
  }
  return filter;
}

function trim(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

interface ListJsonRow {
  readonly clickhouse_rebuild_job_id: string;
  readonly target_projection: string;
  readonly target_table_qualified: string;
  readonly status: ClickhouseRebuildJobStatus;
  readonly source_range_from: string | null;
  readonly source_range_to: string | null;
  readonly rows_estimated: number | null;
  readonly partitions_estimated: number | null;
  readonly requester_actor_label: string;
  readonly created_at: string;
}

function toJsonRow(row: ClickhouseRebuildJobRow): ListJsonRow {
  return {
    clickhouse_rebuild_job_id: row.clickhouse_rebuild_job_id,
    target_projection: row.target_projection,
    target_table_qualified: row.target_table_qualified,
    status: row.status,
    source_range_from: row.source_range_from,
    source_range_to: row.source_range_to,
    rows_estimated: row.rows_estimated,
    partitions_estimated: row.partitions_estimated,
    requester_actor_label: row.requester_actor_label,
    created_at: row.created_at,
  };
}

function emit(
  ctx: CommandContext,
  filter: ListClickhouseRebuildJobsFilter,
  rows: readonly ClickhouseRebuildJobRow[],
): void {
  const view = rows.map(toJsonRow);
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(filter, view),
      json: { filter: filterJson(filter), count: view.length, rows: view },
    }),
  );
}

function filterJson(filter: ListClickhouseRebuildJobsFilter): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (filter.status !== undefined) out["status"] = filter.status;
  if (filter.projection !== undefined) out["projection"] = filter.projection;
  if (filter.limit !== undefined) out["limit"] = filter.limit;
  return Object.keys(out).length === 0 ? null : out;
}

function renderHuman(
  filter: ListClickhouseRebuildJobsFilter,
  rows: readonly ListJsonRow[],
): string {
  const scope: string[] = [];
  if (filter.status !== undefined) scope.push(`status=${filter.status}`);
  if (filter.projection !== undefined) scope.push(`projection=${filter.projection}`);
  if (filter.limit !== undefined) scope.push(`limit=${filter.limit}`);
  const scopeStr = scope.join(" ");
  if (rows.length === 0) {
    return `(no clickhouse-rebuild jobs${scope.length === 0 ? "" : ` for ${scopeStr}`})`;
  }
  const header = `count=${rows.length}${scope.length === 0 ? "" : ` ${scopeStr}`}`;
  const lines: string[] = [header];
  for (const row of rows) {
    const window =
      row.source_range_from === null && row.source_range_to === null
        ? "full-table"
        : `${row.source_range_from ?? "?"}..${row.source_range_to ?? "?"}`;
    lines.push(
      `  ${row.clickhouse_rebuild_job_id} projection=${row.target_projection} status=${row.status} range=${window} rows~${row.rows_estimated ?? "?"} partitions=${row.partitions_estimated ?? "?"} by=${row.requester_actor_label} created_at=${row.created_at}`,
    );
  }
  return lines.join("\n");
}
