/**
 * `polaris clickhouse-rebuild plan --projection <name>
 *   [--from <iso>] [--to <iso>]` — read-only.
 *
 * Renders the deterministic dry-run plan for a hypothetical rebuild.
 * Hands the operator-supplied declaration to the planner in
 * `@polaris/shared-clickhouse/rebuild` and prints the result. Does
 * NOT touch PostgreSQL and does NOT write to ClickHouse. The planner
 * is permitted ONE ClickHouse read (against `system.parts`) for the
 * partition estimate; in unit tests that read is stubbed.
 *
 * The output is the contract the future executor will consume — an
 * operator runs `plan` to pre-flight a rebuild before running
 * `create --dry-run` (which persists the same plan onto a `dry_run`
 * row).
 *
 * Returns exit code 2 (usage) when the planner rejects with any of
 * its closed-set codes (`unknown_projection`, `invalid_range`,
 * `range_empty`, `clickhouse_unreachable`). The error message
 * carries `clickhouse_rebuild_rejected:<code>` so scripts can grep
 * for the rejection.
 *
 * `mutates: false`: bypasses the production gate from P6-007.
 *
 * @see packages/shared-clickhouse/src/rebuild/planner.ts
 * @see docs/architecture/07-clickhouse.md "Replay and Rebuild"
 */
import {
  type ClickhouseRebuildPlanned,
  planClickhouseRebuild,
  REBUILDABLE_CLICKHOUSE_PROJECTION_NAMES,
  renderClickhouseRebuildPlanHuman,
  type PlanClickhouseRebuildOptions,
} from "@polaris/shared-clickhouse/rebuild";
import type { CommandContext, CommandDefinition } from "../../command.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo, renderJson } from "../../output.js";

interface ClickhouseRebuildPlanArgs {
  readonly projection?: string;
  readonly from?: string;
  readonly to?: string;
}

export interface ClickhouseRebuildPlanHooks {
  readonly now?: () => Date;
  /**
   * Partition reader adapter. Required for the happy path; tests
   * inject a stub. The production wiring (deferred to follow-up)
   * uses the shared-clickhouse operator client's `raw.query`
   * escape hatch.
   */
  readonly readPartitions?: PlanClickhouseRebuildOptions["readPartitions"];
}

export const clickhouseRebuildPlanCommand: CommandDefinition = {
  id: "clickhouse-rebuild.plan",
  mutates: false,
  register: (parent, deps) => {
    parent
      .command("plan")
      .description(
        [
          "Dry-run plan for a hypothetical ClickHouse rebuild. Reads system.parts to",
          "estimate partitions + row counts; does NOT persist a row anywhere.",
          "",
          `Allowed --projection values: ${REBUILDABLE_CLICKHOUSE_PROJECTION_NAMES.join(", ")}`,
        ].join("\n"),
      )
      .requiredOption(
        "--projection <name>",
        `Projection to rebuild. Closed set: ${REBUILDABLE_CLICKHOUSE_PROJECTION_NAMES.join(" | ")}.`,
      )
      .option("--from <iso>", "Inclusive source-range start (ISO 8601 UTC).")
      .option("--to <iso>", "Inclusive source-range end (ISO 8601 UTC).")
      .action(deps.runCommand({ id: "clickhouse-rebuild.plan", mutates: false }, runPlan));
  },
};

export function buildClickhouseRebuildPlanRunner(hooks: ClickhouseRebuildPlanHooks = {}) {
  const nowFn = hooks.now ?? (() => new Date());
  const readPartitions = hooks.readPartitions;

  return async function runner(
    args: ClickhouseRebuildPlanArgs,
    ctx: CommandContext,
  ): Promise<undefined> {
    const projection = requireTrim(args.projection, "--projection");
    const fromStr = trim(args.from);
    const toStr = trim(args.to);
    if ((fromStr === undefined) !== (toStr === undefined)) {
      throw new UsageError(
        "--from and --to must be supplied together (full-table plan uses neither).",
      );
    }
    const planOptions: PlanClickhouseRebuildOptions = {
      now: nowFn(),
      ...(readPartitions !== undefined ? { readPartitions } : {}),
    };

    const plan = await planClickhouseRebuild(
      {
        projection,
        fromTs: fromStr ?? null,
        toTs: toStr ?? null,
      },
      planOptions,
    );

    if (plan.kind === "rejected") {
      throw new UsageError(`clickhouse_rebuild_rejected:${plan.code}: ${plan.message}`, {
        code: plan.code,
      });
    }

    emit(ctx, plan);
    return undefined;
  };
}

const runPlan = buildClickhouseRebuildPlanRunner();

function emit(ctx: CommandContext, plan: ClickhouseRebuildPlanned): void {
  if (ctx.config.output === "json") {
    ctx.output.writeOut(renderJson(plan));
    return;
  }
  ctx.output.writeOut(
    renderAccordingTo("human", {
      human: renderClickhouseRebuildPlanHuman(plan),
      json: plan,
    }),
  );
}

function requireTrim(value: string | undefined, flag: string): string {
  if (value === undefined) throw new UsageError(`${flag} is required`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new UsageError(`${flag} is required`);
  return trimmed;
}

function trim(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
