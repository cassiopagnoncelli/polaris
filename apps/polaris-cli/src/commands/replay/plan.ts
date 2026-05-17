/**
 * `polaris replay plan <replay_job_id> [--output human|json]` — read-only.
 *
 * Renders the deterministic dry-run plan for a replay job. The CLI reads
 * the operator-issued declaration out of `replay_jobs`, hands it to the
 * planner in `@polaris/shared-replay`, and prints the resulting
 * {@link ReplayPlan}. No DB writes; no Redpanda reads.
 *
 * The plan output is the contract the future replay executor (P7-003)
 * will consume — running `replay plan` is the operator's pre-flight
 * check before promoting `mode` from `dry_run` to `live`.
 *
 * Returns exit code 2 (usage) when the id is unknown OR when the
 * declaration in the row is malformed (the planner rejects with a
 * structured code). The error message carries the closed-set rejection
 * code so scripts can grep for it.
 *
 * `mutates: false`: bypasses the production gate from P6-007 because
 * this command performs zero state changes.
 *
 * Architectural rule baked in: the CLI MUST NOT accept any flag that
 * resembles planner semantics (partition strategy, chunking rules,
 * transform overrides, topic routing). Those live in versioned code
 * under `@polaris/shared-replay`. The `rejectReplayPlanArguments` gate
 * fires before any DB or planner work.
 *
 * @see packages/shared-replay/src/planner.ts
 * @see docs/architecture/05-processors-and-replay.md "Replay Control Plane"
 * @see docs/implementation/tasks/P7-002-replay-planner-dry-run.md
 */

import {
  type PlanReplayOptions,
  planReplay,
  type ReplayJobDeclaration,
  type ReplayPlan,
  ReplayPlanError,
  renderPlanHuman,
} from "@polaris/shared-replay";
import type { Command } from "commander";
import type { CommandContext, CommandDefinition } from "../../command.js";
import { connectDb, findReplayJobById, type ReplayJobRow } from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo, renderJson } from "../../output.js";
import { rejectReplayPlanArguments } from "./validation.js";

interface ReplayPlanArgs {
  readonly replayJobId: string;
}

export interface ReplayPlanStore {
  findById(replayJobId: string): Promise<ReplayJobRow | null>;
  close(): Promise<void>;
}

export interface ReplayPlanHooks {
  readonly openStore?: () => ReplayPlanStore;
  /**
   * Clock injected for determinism. Defaults to `new Date()`. The
   * planner uses this for `planned_at` and for retention-window checks
   * against the row's `window_from`.
   */
  readonly now?: () => Date;
}

export const replayPlanCommand: CommandDefinition = {
  id: "replay.plan",
  mutates: false,
  register: (parent, deps) => {
    const cmd = parent
      .command("plan <replay_job_id>")
      .description(
        [
          "Dry-run plan for a replay job. Reads the job declaration, runs the",
          "planner, and prints the deterministic plan. Performs no DB writes",
          "and never touches Redpanda. Use --output json to capture the full",
          "machine-readable plan; the human form is a digest.",
        ].join("\n"),
      );
    cmd.action(async (replayJobId: string, _opts: unknown, command: Command) => {
      const wrapped = deps.runCommand<ReplayPlanArgs>(
        { id: "replay.plan", mutates: false },
        runReplayPlan,
      );
      await wrapped({ replayJobId }, command);
    });
  },
};

export function buildReplayPlanRunner(hooks: ReplayPlanHooks = {}) {
  const nowFn = hooks.now ?? (() => new Date());

  return async function runner(args: ReplayPlanArgs, ctx: CommandContext): Promise<undefined> {
    const openStore = hooks.openStore ?? (() => defaultStore(ctx.env));
    // Defence in depth: even though `plan` is read-only and does not
    // accept any --partition / --transform / --chunk flags via
    // commander, run the same rejection sweep the rest of the replay
    // command group uses so a future caller cannot smuggle a
    // planner-shaped key in.
    rejectReplayPlanArguments(args as unknown as Record<string, unknown>);

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
      const declaration = rowToDeclaration(row);
      const planOptions: PlanReplayOptions = { now: nowFn() };
      let plan: ReplayPlan;
      try {
        plan = planReplay(declaration, planOptions);
      } catch (err) {
        if (err instanceof ReplayPlanError) {
          // Surface the planner's structured code in the CLI exit-code
          // message so scripts can grep `replay_plan_rejected:<code>`.
          throw new UsageError(`replay_plan_rejected:${err.code}: ${err.message}`, {
            code: err.code,
            replay_job_id: id,
          });
        }
        throw err;
      }
      emit(ctx, plan);
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runReplayPlan = buildReplayPlanRunner();

function defaultStore(env: NodeJS.ProcessEnv): ReplayPlanStore {
  const handle = connectDb({ env });
  return {
    findById: (id) => findReplayJobById(handle.db, id),
    close: () => handle.close(),
  };
}

/**
 * Project a `replay_jobs` row onto the planner's declaration shape.
 * The row stores only operator-issued intent (P7-001) — partition
 * strategy, chunking, transform overrides do NOT live there. The
 * planner's processor-pin hints (`processor_name`, `processor_version`)
 * are not in v1's row either, so they appear as `undefined` and the
 * planner emits the `processor_target_not_pinned` risk flag. Future
 * work can wire them through without changing this signature.
 */
function rowToDeclaration(row: ReplayJobRow): ReplayJobDeclaration {
  return {
    replay_job_id: row.replay_job_id,
    project_id: row.project_id,
    environment: row.environment,
    target: row.target,
    mode: row.mode,
    window_from: row.window_from,
    window_to: row.window_to,
    event_name: row.event_name,
    event_id: row.event_id,
    // P7-001 does not persist these — the planner emits a risk flag
    // when they are missing on a processor-target plan.
    processor_name: undefined,
    processor_version: undefined,
    // P7-001 does not persist destination opt-in. The default-false
    // behavior is preserved (architecture rule: destinations off
    // unless explicitly opted in).
    destinations_enabled: undefined,
    destination_opt_in_note: undefined,
  };
}

function emit(ctx: CommandContext, plan: ReplayPlan): void {
  const format = ctx.config.output;
  if (format === "json") {
    ctx.output.writeOut(renderJson(plan));
    return;
  }
  ctx.output.writeOut(
    renderAccordingTo(format, {
      human: renderPlanHuman(plan),
      json: plan,
    }),
  );
}
