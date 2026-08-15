/**
 * `polaris traits compute --project X --env Y [--trait key]`
 *
 * Runs the computed-trait definitions for one project and environment. Host
 * cron invokes it; there is no long-lived traits service.
 *
 * ## Why a cron verb and not a consumer
 *
 * A trait is an aggregate over a window, and "orders in the last 30 days"
 * changes when an order lands AND when one ages out. The second half has no
 * event to react to, so a streaming implementation would still need a timer
 * for expiries — and would then have two code paths computing the same
 * number, which is the arrangement where they disagree. One scheduled pass
 * is simpler and is the only one of the two that can be reasoned about.
 *
 * The attribution-prune jobs already established this shape; the crontab
 * example staggers this alongside them.
 *
 * ## Idempotent by construction
 *
 * Running it twice writes nothing the second time. The runner diffs against
 * stored values and writes only changes, so a re-run over an unchanged
 * population bumps no `traits_version` and emits no `profile.updated`. That
 * is what makes it safe for cron to overlap a manual invocation, and why the
 * command needs no lock.
 *
 * `--trait` narrows to one definition, for the case an operator has just
 * edited one and does not want to pay for the rest.
 */

import { TRAIT_DEFINITIONS } from "@polaris/trait-catalog";
import type { Command } from "commander";

import type { CommandContext, CommandDefinition } from "../../command.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import { buildRegisteredTraitsRunner } from "./registration.js";

export interface TraitsComputeArgs {
  readonly project?: string;
  readonly env?: string;
  readonly trait?: string;
}

/** What the command needs from the runner. Injected so tests need no cluster. */
export interface TraitsComputeRunner {
  run(input: {
    readonly projectId: string;
    readonly environment: string;
    readonly traits: ReadonlyArray<{ readonly key: string; readonly sql: string }>;
  }): Promise<{
    readonly profilesChanged: number;
    readonly perTrait: ReadonlyArray<{
      readonly key: string;
      readonly computed: number;
      readonly changed: number;
      readonly removed: number;
    }>;
  }>;
}

export interface TraitsComputeHooks {
  readonly runner?: (ctx: CommandContext) => TraitsComputeRunner;
}

export function buildTraitsComputeRunner(hooks: TraitsComputeHooks = {}) {
  return async function runner(args: TraitsComputeArgs, ctx: CommandContext): Promise<undefined> {
    const projectId = args.project?.trim();
    const environment = args.env?.trim();
    if (projectId === undefined || projectId.length === 0) {
      throw new UsageError("--project is required");
    }
    if (environment === undefined || environment.length === 0) {
      throw new UsageError("--env is required");
    }

    const selected = selectTraits(args.trait?.trim());

    if (hooks.runner === undefined) {
      throw new UsageError("traits compute has no runner configured");
    }
    const result = await hooks.runner(ctx).run({ projectId, environment, traits: selected });

    ctx.output.writeOut(
      renderAccordingTo(ctx.config.output, {
        human: [
          `traits computed for ${projectId}/${environment}`,
          ...result.perTrait.map(
            (t) =>
              `  ${t.key.padEnd(24)} computed=${String(t.computed)} ` +
              `changed=${String(t.changed)} removed=${String(t.removed)}`,
          ),
          `profiles changed: ${String(result.profilesChanged)}`,
        ].join("\n"),
        json: {
          project_id: projectId,
          environment,
          profiles_changed: result.profilesChanged,
          traits: result.perTrait,
        },
      }),
    );
    return undefined;
  };
}

/**
 * Resolve `--trait` against the registry.
 *
 * An unknown key is a usage error rather than an empty run. A cron line with
 * a typo'd trait name would otherwise succeed nightly, compute nothing, and
 * report success — the failure mode where the job is green and the trait is
 * months stale.
 */
function selectTraits(key: string | undefined): ReadonlyArray<{ key: string; sql: string }> {
  if (key === undefined || key.length === 0) {
    return TRAIT_DEFINITIONS.map((d) => ({ key: d.key, sql: d.sql }));
  }
  const found = TRAIT_DEFINITIONS.find((d) => d.key === key);
  if (found === undefined) {
    throw new UsageError(
      `unknown trait "${key}". Defined: ${TRAIT_DEFINITIONS.map((d) => d.key).join(", ")}`,
    );
  }
  return [{ key: found.key, sql: found.sql }];
}

export const traitsComputeCommand: CommandDefinition = {
  id: "traits.compute",
  mutates: true,
  register: (parent, deps) => {
    parent
      .command("compute")
      .description("Compute trait definitions for one project and environment")
      .requiredOption("--project <id>")
      .requiredOption("--env <environment>")
      .option("--trait <key>", "compute only this definition")
      .action(async (opts: TraitsComputeArgs, command: Command) => {
        const wrapped = deps.runCommand<TraitsComputeArgs>(
          { id: "traits.compute", mutates: true },
          buildTraitsComputeRunner({ runner: buildRegisteredTraitsRunner }),
        );
        await wrapped(opts, command);
      });
  },
};
