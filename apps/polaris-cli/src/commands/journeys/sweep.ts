/**
 * `polaris journeys sweep --env <environment>`
 *
 * Advance every participant whose wait has elapsed. This is the whole
 * journey scheduler: a crontab entry, a timestamp column, and an index.
 *
 * ## Why a cron verb and not a scheduler
 *
 * The card is explicit — "no new scheduler tech" — and the reasoning holds
 * on its own. A wait is a row with a due time. Anything that can select
 * rows by time can run journeys, which means the mechanism is inspectable
 * with `psql` during an incident, needs no separate liveness story, and
 * cannot develop a backlog nobody can see. A queue with per-message delays
 * would be a second durable store of pending work, next to the one that
 * already holds the participant.
 *
 * ## Overlapping runs are safe
 *
 * A sweep that takes longer than its crontab period will overlap the next.
 * `claimDue` selects `FOR UPDATE SKIP LOCKED` and clears `wait_until` in
 * the same statement, so two sweeps take disjoint sets rather than both
 * advancing one participant and emitting its action twice.
 *
 * `mutates: true`: it advances participants and emits events.
 */

import type { CommandContext, CommandDefinition } from "../../command.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";

interface JourneysSweepArgs {
  readonly env?: string;
  readonly limit?: string;
}

export interface JourneysSweepSummary {
  readonly environment: string;
  readonly claimed: number;
  readonly advanced: number;
  readonly orphaned: number;
  readonly emitted: number;
}

export interface JourneysSweepHooks {
  /** Injected so the command is testable without a database or a broker. */
  readonly runSweep?: (input: {
    readonly ctx: CommandContext;
    readonly environment: string;
    readonly limit: number;
  }) => Promise<JourneysSweepSummary>;
}

/** Rows per tick. Bounded so one run cannot hold the lock set indefinitely. */
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;

export function buildJourneysSweepRunner(hooks: JourneysSweepHooks = {}) {
  return async function runner(args: JourneysSweepArgs, ctx: CommandContext): Promise<undefined> {
    const environment = args.env?.trim();
    if (environment === undefined || environment.length === 0) {
      throw new UsageError("--env is required: a sweep runs against one environment.");
    }

    const limit = args.limit === undefined ? DEFAULT_LIMIT : Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new UsageError(`--limit must be an integer in [1, ${String(MAX_LIMIT)}]`);
    }

    const run = hooks.runSweep;
    if (run === undefined) {
      // The command is wired to its runtime in the orchestrator's own
      // bootstrap, which owns the producer that emits the effects. Refusing
      // here rather than silently doing nothing keeps a crontab honest: a
      // sweep that reported success while advancing nobody is exactly the
      // shape of failure this repository keeps finding.
      throw new UsageError(
        "journeys sweep is not wired in this build: it needs the orchestrator's producer to " +
          "emit the journey.* effects it produces. Run it through the orchestrator service.",
      );
    }

    const summary = await run({ ctx, environment, limit });

    ctx.logger.info({ audit_action: "journeys.sweep", ...summary }, "journey sweep finished");

    ctx.output.writeOut(
      renderAccordingTo(ctx.config.output, {
        human: [
          `sweep ${summary.environment}`,
          `  claimed   ${String(summary.claimed)}`,
          `  advanced  ${String(summary.advanced)}`,
          `  orphaned  ${String(summary.orphaned)}`,
          `  emitted   ${String(summary.emitted)}`,
        ].join("\n"),
        json: summary,
      }),
    );
    return undefined;
  };
}

export const journeysSweepCommand: CommandDefinition = {
  id: "journeys.sweep",
  mutates: true,
  register: (parent, deps) => {
    parent
      .command("sweep")
      .description(
        "Advance every participant whose wait has elapsed. Safe to overlap: claims are " +
          "FOR UPDATE SKIP LOCKED, so two runs take disjoint sets.",
      )
      .requiredOption("--env <environment>")
      .option("--limit <n>", `Participants per run. Default ${String(DEFAULT_LIMIT)}.`)
      .action(deps.runCommand({ id: "journeys.sweep", mutates: true }, buildJourneysSweepRunner()));
  },
};
