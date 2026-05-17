/**
 * `polaris clickhouse-rebuild show <id>` — read-only.
 *
 * Renders the full rebuild-job row including range bounds, requester
 * label, planner estimates, lifecycle timestamps, and error
 * classification (when failed).
 *
 * Returns exit code 2 (usage) when the id is unknown.
 *
 * `mutates: false`: bypasses the production gate from P6-007.
 */
import type { Command } from "commander";
import type { CommandContext, CommandDefinition } from "../../command.js";
import {
  type ClickhouseRebuildJobRow,
  connectDb,
  findClickhouseRebuildJobById,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";

interface ClickhouseRebuildShowArgs {
  readonly id: string;
}

export interface ClickhouseRebuildShowStore {
  findById(jobId: string): Promise<ClickhouseRebuildJobRow | null>;
  close(): Promise<void>;
}

export interface ClickhouseRebuildShowHooks {
  readonly openStore?: () => ClickhouseRebuildShowStore;
}

export const clickhouseRebuildShowCommand: CommandDefinition = {
  id: "clickhouse-rebuild.show",
  mutates: false,
  register: (parent, deps) => {
    const cmd = parent
      .command("show <clickhouse_rebuild_job_id>")
      .description("Show one ClickHouse rebuild job's full row, including planner estimates.");
    cmd.action(async (id: string, _opts: unknown, command: Command) => {
      const wrapped = deps.runCommand<ClickhouseRebuildShowArgs>(
        { id: "clickhouse-rebuild.show", mutates: false },
        runShow,
      );
      await wrapped({ id }, command);
    });
  },
};

export function buildClickhouseRebuildShowRunner(hooks: ClickhouseRebuildShowHooks = {}) {
  return async function runner(
    args: ClickhouseRebuildShowArgs,
    ctx: CommandContext,
  ): Promise<undefined> {
    const openStore = hooks.openStore ?? (() => defaultStore(ctx.env));
    const id = args.id.trim();
    if (id.length === 0) {
      throw new UsageError("clickhouse_rebuild_job_id is required");
    }
    const store = openStore();
    try {
      const row = await store.findById(id);
      if (row === null) {
        throw new UsageError(`clickhouse rebuild job "${id}" not found`);
      }
      emit(ctx, row);
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runShow = buildClickhouseRebuildShowRunner();

function defaultStore(env: NodeJS.ProcessEnv): ClickhouseRebuildShowStore {
  const handle = connectDb({ env });
  return {
    findById: (id) => findClickhouseRebuildJobById(handle.db, id),
    close: () => handle.close(),
  };
}

function emit(ctx: CommandContext, row: ClickhouseRebuildJobRow): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(row),
      json: row,
    }),
  );
}

function renderHuman(row: ClickhouseRebuildJobRow): string {
  return [
    "polaris clickhouse-rebuild job",
    `  clickhouse_rebuild_job_id  ${row.clickhouse_rebuild_job_id}`,
    `  target_projection          ${row.target_projection}`,
    `  target_table_qualified     ${row.target_table_qualified}`,
    `  source_range_from          ${row.source_range_from ?? "(full table)"}`,
    `  source_range_to            ${row.source_range_to ?? "(full table)"}`,
    `  status                     ${row.status}`,
    `  rows_estimated             ${row.rows_estimated ?? "(unknown)"}`,
    `  partitions_estimated       ${row.partitions_estimated ?? "(unknown)"}`,
    `  requester_actor_label      ${row.requester_actor_label}`,
    `  reason                     ${row.reason}`,
    `  error_class                ${row.error_class ?? "(none)"}`,
    `  error_message              ${row.error_message ?? "(none)"}`,
    `  created_at                 ${row.created_at}`,
    `  updated_at                 ${row.updated_at}`,
    `  started_at                 ${row.started_at ?? "(not started)"}`,
    `  completed_at               ${row.completed_at ?? "(not completed)"}`,
  ].join("\n");
}
