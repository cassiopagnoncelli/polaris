/**
 * `polaris replay show <replay_job_id>` — read-only.
 *
 * Renders the full replay-job row including window bounds, scope, target,
 * mode, status, lifecycle timestamps, operator label + reason, and the
 * planner/executor counters (events_planned / events_replayed /
 * events_failed). Useful for triaging an in-flight or completed job.
 *
 * Returns exit code 2 (usage) when the id is unknown.
 *
 * `mutates: false`: bypasses the production gate from P6-007.
 *
 * @see docs/architecture/05-processors-and-replay.md "Replay Control Plane"
 * @see docs/implementation/tasks/P7-001-replay-job-model-cli.md
 */
import type { Command } from "commander";
import type { CommandContext, CommandDefinition } from "../../command.js";
import { type ReplayJobRow, connectDb, findReplayJobById } from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";

interface ReplayShowArgs {
  readonly replayJobId: string;
}

export interface ReplayShowStore {
  findById(replayJobId: string): Promise<ReplayJobRow | null>;
  close(): Promise<void>;
}

export interface ReplayShowHooks {
  readonly openStore?: () => ReplayShowStore;
}

export const replayShowCommand: CommandDefinition = {
  id: "replay.show",
  mutates: false,
  register: (parent, deps) => {
    const cmd = parent
      .command("show <replay_job_id>")
      .description("Show one replay job's full state, window, and counters.");
    cmd.action(async (replayJobId: string, _opts: unknown, command: Command) => {
      const wrapped = deps.runCommand<ReplayShowArgs>(
        { id: "replay.show", mutates: false },
        runReplayShow,
      );
      await wrapped({ replayJobId }, command);
    });
  },
};

export function buildReplayShowRunner(hooks: ReplayShowHooks = {}) {
  const openStore = hooks.openStore ?? defaultStore;

  return async function runner(args: ReplayShowArgs, ctx: CommandContext): Promise<undefined> {
    const id = args.replayJobId.trim();
    if (id.length === 0) {
      throw new UsageError("replay_job_id is required");
    }

    const store = openStore();
    try {
      const row = await store.findById(id);
      if (row === null) {
        throw new UsageError(`replay job "${id}" not found`);
      }
      emit(ctx, row);
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runReplayShow = buildReplayShowRunner();

function defaultStore(): ReplayShowStore {
  const handle = connectDb({ env: process.env });
  return {
    findById: (id) => findReplayJobById(handle.db, id),
    close: () => handle.close(),
  };
}

function emit(ctx: CommandContext, row: ReplayJobRow): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(row),
      json: row,
    }),
  );
}

function renderHuman(row: ReplayJobRow): string {
  return [
    `polaris replay job`,
    `  replay_job_id    ${row.replay_job_id}`,
    `  project_id       ${row.project_id}`,
    `  environment      ${row.environment}`,
    `  event_name       ${row.event_name ?? "(all)"}`,
    `  event_id         ${row.event_id ?? "(all)"}`,
    `  target           ${row.target}`,
    `  mode             ${row.mode}`,
    `  status           ${row.status}`,
    `  window_from      ${row.window_from}`,
    `  window_to        ${row.window_to}`,
    `  created_at       ${row.created_at}`,
    `  created_by       ${row.created_by}`,
    `  reason           ${row.reason}`,
    `  planned_at       ${row.planned_at ?? "(pending)"}`,
    `  started_at       ${row.started_at ?? "(not started)"}`,
    `  finished_at      ${row.finished_at ?? "(not finished)"}`,
    `  events_planned   ${row.events_planned}`,
    `  events_replayed  ${row.events_replayed}`,
    `  events_failed    ${row.events_failed}`,
  ].join("\n");
}
