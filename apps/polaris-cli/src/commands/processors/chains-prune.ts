/**
 * `polaris processors chains-prune --version <v> [--project <id>]
 * [--env <env>] [--idle <seconds>] [--dry-run]` — mutating.
 *
 * Deletes `attribution_touchpoint_chains` rows the processor's own
 * attribution window has already made unreadable, and writes one audit
 * row for the operation.
 *
 * The safety argument lives in the mutation
 * (`@polaris/persistence-control-plane`'s `pruneAttributionChainsWithAudit`)
 * rather than here, so a scheduled job or the control-plane API inherits
 * it. The short version: attribution-engine v2 resets a chain after a
 * 90-day inactivity gap, so a row idle longer than that can never be read
 * again and deleting it cannot change output. v1 has no window, so the
 * same delete WOULD change output — the command refuses it.
 *
 * `--dry-run` counts without deleting and writes no audit row.
 *
 * `mutates: true`, so P6-007 gates it against production-without-token.
 */

import { type ActorSource, enforceProductionMutationGate } from "@polaris/tenancy-control-plane";
import { POLARIS_ENVIRONMENTS } from "@polaris/runtime-environments";
import type { Command } from "commander";
import { v7 as uuidv7 } from "uuid";
import type { CommandContext, CommandDefinition } from "../../command.js";
import { connectDb, pruneAttributionChainsWithAudit } from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import { rejectProcessorRuleArguments } from "./validation.js";

const SUPPORTED_ENVIRONMENTS = POLARIS_ENVIRONMENTS;

export interface ChainsPruneArgs {
  readonly version?: string;
  readonly project?: string;
  readonly env?: string;
  readonly idle?: string;
  readonly dryRun?: boolean;
}

export interface ChainsPruneStore {
  prune(input: {
    processorVersion: string;
    idleSeconds?: number;
    projectId?: string | null;
    environment?: string | null;
    dryRun: boolean;
    actorLabel: string;
    actorSource: ActorSource;
  }): Promise<{
    applied: boolean;
    rows: number;
    idleSeconds: number;
    cutoff: Date;
    dryRun: boolean;
  }>;
  close(): Promise<void>;
}

export interface ChainsPruneHooks {
  readonly openStore?: () => ChainsPruneStore;
}

export const processorsChainsPruneCommand: CommandDefinition = {
  id: "processors.chains-prune",
  mutates: true,
  register: (parent, deps) => {
    parent
      .command("chains-prune")
      .description(
        "Delete attribution touchpoint chains idle beyond the processor version's attribution window.",
      )
      .requiredOption("--version <version>", "Processor version whose chains to prune (e.g. v2).")
      .option("--project <project_id>", "Restrict to one project. Omit to prune all.")
      .option("--env <environment>", "Restrict to one environment. Omit to prune all.")
      .option(
        "--idle <seconds>",
        "Delete chains idle longer than this. Defaults to the version's window; shorter values are refused.",
      )
      .option("--dry-run", "Count what would be deleted without deleting it.")
      .action(async (opts: ChainsPruneArgs, command: Command) => {
        const wrapped = deps.runCommand<ChainsPruneArgs>(
          { id: "processors.chains-prune", mutates: true },
          runProcessorsChainsPrune,
        );
        await wrapped(opts, command);
      });
  },
};

export function buildProcessorsChainsPruneRunner(hooks: ChainsPruneHooks = {}) {
  return async function runner(args: ChainsPruneArgs, ctx: CommandContext): Promise<undefined> {
    rejectProcessorRuleArguments(args as Record<string, unknown>);

    const version = args.version?.trim();
    if (version === undefined || version.length === 0) {
      throw new UsageError("--version is required");
    }
    if (args.env !== undefined && !SUPPORTED_ENVIRONMENTS.includes(args.env as never)) {
      throw new UsageError(`--env must be one of ${SUPPORTED_ENVIRONMENTS.join(", ")}`);
    }

    let idleSeconds: number | undefined;
    if (args.idle !== undefined) {
      idleSeconds = Number(args.idle);
      if (!Number.isInteger(idleSeconds) || idleSeconds <= 0) {
        throw new UsageError("--idle must be a positive integer number of seconds");
      }
    }

    const dryRun = args.dryRun ?? false;

    // An unscoped prune deletes production rows, so it must clear the
    // production gate — but the dispatcher's gate never fires for it. The
    // gate reads the environment from `--env`, and on THIS command `--env`
    // is a scope filter: omitting it means "every environment", including
    // production. So the run declared no environment while doing the most
    // far-reaching thing it can do, and an unauthenticated caller deleted
    // production chains. Found by running the scheduled job for real.
    //
    // Re-enforcing here rather than reimplementing the rule: same
    // function, same refusal, same message. A dry run is exempt — it
    // reads and deletes nothing.
    if (!dryRun && args.env === undefined) {
      enforceProductionMutationGate({
        command: { id: "processors.chains-prune", mutates: true },
        environment: "production",
        actor: ctx.actor,
      });
    }
    const store = (hooks.openStore ?? (() => defaultStore(ctx.env)))();
    try {
      const outcome = await store.prune({
        processorVersion: version,
        ...(idleSeconds !== undefined ? { idleSeconds } : {}),
        projectId: args.project ?? null,
        environment: args.env ?? null,
        dryRun,
        actorLabel: ctx.actor.label,
        // The real credential, not a hardcoded "cli". An operator token
        // that authenticated this prune should say so in the audit row.
        actorSource: ctx.actor.source,
      });

      const scope = [
        args.project === undefined ? "all projects" : `project ${args.project}`,
        args.env === undefined ? "all environments" : `env ${args.env}`,
      ].join(", ");

      ctx.output.writeOut(
        renderAccordingTo(ctx.config.output, {
          human: outcome.dryRun
            ? `dry run: ${String(outcome.rows)} ${version} chain(s) idle since before ${outcome.cutoff.toISOString()} would be deleted (${scope}).\n`
            : `pruned ${String(outcome.rows)} ${version} chain(s) idle since before ${outcome.cutoff.toISOString()} (${scope}).\n`,
          json: {
            applied: outcome.applied,
            dry_run: outcome.dryRun,
            processor_version: version,
            rows: outcome.rows,
            idle_seconds: outcome.idleSeconds,
            cutoff: outcome.cutoff.toISOString(),
            project_id: args.project ?? null,
            environment: args.env ?? null,
          },
        }),
      );
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runProcessorsChainsPrune = buildProcessorsChainsPruneRunner();

function defaultStore(env: NodeJS.ProcessEnv): ChainsPruneStore {
  const handle = connectDb({ env });
  return {
    prune: async (input) =>
      pruneAttributionChainsWithAudit(
        handle.db,
        {
          processorVersion: input.processorVersion,
          ...(input.idleSeconds !== undefined ? { idleSeconds: input.idleSeconds } : {}),
          projectId: input.projectId ?? null,
          environment: input.environment ?? null,
          dryRun: input.dryRun,
        },
        {
          auditId: `polaris_aud_${uuidv7()}`,
          actorSource: input.actorSource,
          actorLabel: input.actorLabel,
          occurredAt: new Date(),
        },
      ),
    close: () => handle.close(),
  };
}
