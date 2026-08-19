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

    // Default: build the orchestrator with its runtime stopped and drive one
    // sweep through it. The service owns the producer that publishes the
    // effects, so borrowing it is what makes a cron invocation equivalent to
    // the in-service loop rather than a second, differently-wired path.
    const run = hooks.runSweep ?? defaultRunSweep;
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

/**
 * Drive one sweep through a non-consuming orchestrator instance.
 *
 * `startRuntime: false` and `sweepIntervalMs: 0`: this process subscribes
 * to nothing and starts no timer. It connects a producer, claims the due
 * participants, publishes their effects and exits — which is what a crontab
 * wants, and it reuses the service's own publish path rather than a second
 * copy of it that could drift.
 */
async function defaultRunSweep(input: {
  readonly ctx: CommandContext;
  readonly environment: string;
  readonly limit: number;
}): Promise<JourneysSweepSummary> {
  const { buildJourneyOrchestratorApp, loadJourneyOrchestratorConfig } = await import(
    "@polaris/processor-journey-orchestrator-v1"
  );

  // The orchestrator's config demands the same env every service does, and
  // `serviceName` in the loader only labels errors — it does not supply
  // `POLARIS_SERVICE_NAME`. A cron invocation is standing in FOR the
  // service here, so it declares the same identity rather than inventing a
  // second config path that could drift from the one the service uses.
  process.env["POLARIS_SERVICE_NAME"] ??= "journey-orchestrator";
  // The service port from infra/service-ports.json. This process starts no
  // listener it needs —  — but the config schema wants
  // a valid port, and borrowing a second one would put a number in a third
  // place the port registry does not know about.
  process.env["POLARIS_HTTP_PORT"] ??= "4023";

  const config = loadJourneyOrchestratorConfig();
  const app = await buildJourneyOrchestratorApp({
    config,
    startRuntime: false,
    installShutdown: false,
    sweepIntervalMs: 0,
  });
  try {
    // `--env` is the DATA environment and is honoured here. It was being
    // accepted and ignored, so a sweep read whichever environment the
    // process happened to run in.
    const result = await app.runSweepOnce({ limit: input.limit, environment: input.environment });
    return {
      environment: input.environment,
      claimed: result.claimed,
      advanced: result.advanced,
      orphaned: result.orphaned,
      emitted: result.emitted,
    };
  } finally {
    await app.bootstrap.shutdown().catch(() => undefined);
  }
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
