/**
 * `polaris audiences compute --project X --env Y [--audience key]`
 *
 * Evaluates the audience definitions for one project and environment. Host
 * cron invokes it; there is no long-lived audiences service.
 *
 * ## Ordering against traits
 *
 * Audiences read computed traits, so they run AFTER `polaris traits
 * compute`. Running them before is not an error, only stale by one cycle —
 * the population reflects yesterday's traits. `infra/backups/crontab.example`
 * staggers them accordingly.
 *
 * ## Idempotent by construction
 *
 * Running it twice writes nothing and emits nothing the second time. The
 * runner diffs desired membership against stored and acts only on
 * transitions, so a re-run over an unchanged population is free. That is
 * what makes cron overlapping a manual invocation safe, and why the
 * command needs no lock — the same argument `traits compute` makes.
 *
 * `--audience` narrows to one definition, for the case an operator has
 * just edited one and does not want to pay for the rest.
 */

import { AUDIENCE_DEFINITIONS, type AudienceDefinition } from "@polaris/audience-catalog";
import type { Command } from "commander";

import type { CommandContext, CommandDefinition } from "../../command.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import { buildRegisteredAudiencesRunner } from "./registration.js";

export interface AudiencesComputeArgs {
  readonly project?: string;
  readonly env?: string;
  readonly audience?: string;
}

/** What the command needs from the runner. Injected so tests need no cluster. */
export interface AudiencesComputeRunner {
  run(input: {
    readonly projectId: string;
    readonly environment: string;
    readonly audiences: readonly AudienceDefinition[];
  }): Promise<{
    readonly transitions: number;
    readonly perAudience: ReadonlyArray<{
      readonly key: string;
      readonly version: number;
      readonly members: number;
      readonly entered: number;
      readonly exited: number;
      readonly restamped: number;
    }>;
  }>;
}

export interface AudiencesComputeHooks {
  readonly runner?: (ctx: CommandContext) => AudiencesComputeRunner;
}

export function buildAudiencesComputeRunner(hooks: AudiencesComputeHooks = {}) {
  return async function runner(
    args: AudiencesComputeArgs,
    ctx: CommandContext,
  ): Promise<undefined> {
    const projectId = args.project?.trim();
    const environment = args.env?.trim();
    if (projectId === undefined || projectId.length === 0) {
      throw new UsageError("--project is required");
    }
    if (environment === undefined || environment.length === 0) {
      throw new UsageError("--env is required");
    }

    const selected = selectAudiences(args.audience?.trim());

    if (hooks.runner === undefined) {
      throw new UsageError("audiences compute has no runner configured");
    }
    const result = await hooks.runner(ctx).run({ projectId, environment, audiences: selected });

    ctx.output.writeOut(
      renderAccordingTo(ctx.config.output, {
        human: [
          `audiences computed for ${projectId}/${environment}`,
          ...result.perAudience.map(
            (a) =>
              `  ${a.key.padEnd(24)} v${String(a.version)} members=${String(a.members)} ` +
              `entered=${String(a.entered)} exited=${String(a.exited)} ` +
              `restamped=${String(a.restamped)}`,
          ),
          `transitions emitted: ${String(result.transitions)}`,
        ].join("\n"),
        json: {
          project_id: projectId,
          environment,
          transitions: result.transitions,
          audiences: result.perAudience,
        },
      }),
    );
    return undefined;
  };
}

/**
 * Resolve `--audience` against the registry.
 *
 * An unknown key is a usage error rather than an empty run. A cron line
 * with a typo'd audience name would otherwise succeed nightly, compute
 * nothing, and report success — the failure mode where the job is green
 * and the audience is months stale.
 */
function selectAudiences(key: string | undefined): readonly AudienceDefinition[] {
  if (key === undefined || key.length === 0) return AUDIENCE_DEFINITIONS;
  const found = AUDIENCE_DEFINITIONS.find((d) => d.key === key);
  if (found === undefined) {
    throw new UsageError(
      `unknown audience "${key}". Defined: ${AUDIENCE_DEFINITIONS.map((d) => d.key).join(", ")}`,
    );
  }
  return [found];
}

export const audiencesComputeCommand: CommandDefinition = {
  id: "audiences.compute",
  mutates: true,
  register: (parent, deps) => {
    parent
      .command("compute")
      .description("Evaluate audience definitions for one project and environment")
      .requiredOption("--project <id>")
      .requiredOption("--env <environment>")
      .option("--audience <key>", "compute only this definition")
      .action(async (opts: AudiencesComputeArgs, command: Command) => {
        const wrapped = deps.runCommand<AudiencesComputeArgs>(
          { id: "audiences.compute", mutates: true },
          buildAudiencesComputeRunner({ runner: buildRegisteredAudiencesRunner }),
        );
        await wrapped(opts, command);
      });
  },
};
