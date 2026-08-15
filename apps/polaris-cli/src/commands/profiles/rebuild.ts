/**
 * `polaris profiles rebuild --project X --env Y`
 *
 * The un-merge mechanism. Polaris merges profiles from evidence, and
 * evidence can be wrong — a shared kiosk, a recycled email, a denylisted
 * identifier that should never have linked anyone. There is no "split this
 * profile" operation, and there deliberately isn't one: unpicking a merge in
 * place means deciding which of the survivor's identifiers, traits, sessions
 * and attribution chains belonged to which side, and every one of those
 * answers would be a guess.
 *
 * So the profile plane is rebuilt from the events instead. Pause the
 * resolver for the project, truncate its profile scope, replay `raw.events`
 * through the new rules, resume. What comes out is what the current rules
 * would have concluded all along, which is the only definition of "correct"
 * available.
 *
 * ## The four steps are ordered for one reason
 *
 *   pause -> truncate -> replay -> resume
 *
 * The resolver must be paused BEFORE the truncate, or live traffic writes
 * profiles into the scope being emptied and the rebuild races itself. It
 * must be resumed only AFTER the replay, or the same events arrive twice —
 * once from the replay and once from the live stream — and the resolver's
 * advisory locks would serialise them into a merge nobody asked for.
 *
 * That ordering is why this is a command rather than a runbook of four
 * commands: three of the four orderings are wrong and two of them are wrong
 * quietly.
 *
 * ## Rebuild depth is bounded by retention, and says so
 *
 * The replay can only reach as far back as `raw.events` is retained. A
 * profile whose first sighting is older than the window is rebuilt from its
 * visible history only, which means a customer of five years may come out
 * with a `first_seen_at` of ninety days ago.
 *
 * The command reports that bound rather than hiding it — an operator who
 * rebuilds to fix an over-merge and silently loses five years of lineage has
 * been given a worse problem than the one they started with. R10 lifts the
 * bound by adding an archive replay source; until then the honest answer is
 * a printed warning and a recorded `depth_bounded_by` on the job.
 *
 * ## Production requires an operator token
 *
 * This truncates a project's profile plane. `--project` is the whole blast
 * radius, and a mistyped project id in production is unrecoverable in the
 * sense that matters: the rebuild will succeed, against the wrong project,
 * and the only remedy is another rebuild.
 */

import type { Command } from "commander";
import { v7 as uuidv7 } from "uuid";

import type { CommandContext, CommandDefinition } from "../../command.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import { buildRegisteredRebuildDriver } from "./rebuild-registration.js";

/** Steps, in the order they must run. */
export const REBUILD_STEPS = ["pause", "truncate", "replay", "resume"] as const;
export type RebuildStep = (typeof REBUILD_STEPS)[number];

export interface ProfilesRebuildArgs {
  readonly project?: string;
  readonly env?: string;
  readonly reason?: string;
  /** Skip the confirmation prompt. Required in non-interactive use. */
  readonly yes?: boolean;
}

export interface RebuildJob {
  readonly job_id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly reason: string;
  readonly steps_completed: readonly RebuildStep[];
  /** What limited how far back the replay could reach. */
  readonly depth_bounded_by: "raw_events_retention";
  readonly retention_days: number;
}

export interface ProfilesRebuildDriver {
  /**
   * Stop the resolver writing to this project's profile scope. Returns when
   * in-flight resolutions have drained — a pause that returned early would
   * leave writes landing during the truncate.
   */
  pause(input: { projectId: string; environment: string }): Promise<void>;
  /** Empty the project's profile plane. */
  truncate(input: { projectId: string; environment: string }): Promise<void>;
  /** Replay `raw.events` for the project through the resolver. */
  replay(input: {
    projectId: string;
    environment: string;
  }): Promise<{ readonly retentionDays: number }>;
  resume(input: { projectId: string; environment: string }): Promise<void>;
  /** Persist the job so a crash mid-rebuild is diagnosable. */
  recordJob(job: RebuildJob): Promise<void>;
}

export interface ProfilesRebuildHooks {
  /**
   * Built PER INVOCATION, not once at registration: the driver's audit
   * context carries THIS run's actor and reason, and a driver constructed
   * at registration would stamp every rebuild with the first one's.
   */
  readonly driver?: (
    ctx: CommandContext,
    scope: { readonly projectId: string; readonly environment: string; readonly reason: string },
  ) => ProfilesRebuildDriver;
  readonly generateJobId?: () => string;
}

export function buildProfilesRebuildRunner(hooks: ProfilesRebuildHooks = {}) {
  const generateJobId = hooks.generateJobId ?? (() => `polaris_rbj_${uuidv7()}`);

  return async function runner(args: ProfilesRebuildArgs, ctx: CommandContext): Promise<undefined> {
    const projectId = args.project?.trim();
    const environment = args.env?.trim();
    if (projectId === undefined || projectId.length === 0) {
      throw new UsageError("--project is required");
    }
    if (environment === undefined || environment.length === 0) {
      throw new UsageError("--env is required");
    }
    const reason = args.reason?.trim();
    if (reason === undefined || reason.length === 0) {
      throw new UsageError("--reason is required for audit traceability");
    }

    // The gate. A rebuild truncates a project's profile plane, and a
    // mistyped project id succeeds — against the wrong project — leaving
    // another rebuild as the only remedy.
    if (environment === "production" && ctx.actor.source !== "operator_token") {
      throw new UsageError(
        "rebuilding a production profile plane requires an operator token; " +
          `this invocation is authenticated as "${ctx.actor.source}"`,
      );
    }
    if (args.yes !== true) {
      throw new UsageError(
        `this truncates every profile for ${projectId}/${environment} and rebuilds them from ` +
          "raw.events. Pass --yes once you have read the runbook at " +
          "docs/operations/runbook-profile-rebuild.md",
      );
    }

    if (hooks.driver === undefined) {
      // Reachable only from a caller that built the runner without hooks.
      // The registered command always supplies one; refusing beats
      // pretending, because a command that printed a plan and changed
      // nothing would read as a successful rebuild.
      throw new UsageError("profiles rebuild has no driver configured");
    }
    const driver = hooks.driver(ctx, { projectId, environment, reason });

    const jobId = generateJobId();
    const completed: RebuildStep[] = [];
    let retentionDays = 0;

    // Ordered deliberately; see the module header. A failure part-way leaves
    // the job recorded with the steps that DID complete, which is what makes
    // "the rebuild died after the truncate" a diagnosable state rather than
    // an empty profile plane nobody can explain.
    try {
      await driver.pause({ projectId, environment });
      completed.push("pause");
      await driver.truncate({ projectId, environment });
      completed.push("truncate");
      const replayed = await driver.replay({ projectId, environment });
      retentionDays = replayed.retentionDays;
      completed.push("replay");
    } finally {
      // ALWAYS. A rebuild that failed after the pause must not leave the
      // resolver paused — that would turn a failed repair into an outage,
      // and the profile plane is already empty at that point.
      try {
        await driver.resume({ projectId, environment });
        completed.push("resume");
      } catch {
        // Reported through the job below rather than masking the original
        // failure with a second one.
      }
      await driver.recordJob({
        job_id: jobId,
        project_id: projectId,
        environment,
        reason,
        steps_completed: [...completed],
        depth_bounded_by: "raw_events_retention",
        retention_days: retentionDays,
      });
    }

    ctx.output.writeOut(
      renderAccordingTo(ctx.config.output, {
        human:
          `rebuild ${jobId}: ${completed.join(" -> ")}\n` +
          `depth: bounded by raw.events retention (${String(retentionDays)} days). A profile ` +
          "whose first sighting is older than that is rebuilt from its visible history only — " +
          "first_seen_at will move forward. R10 lifts this with an archive replay source.",
        json: {
          job_id: jobId,
          project_id: projectId,
          environment,
          steps_completed: completed,
          depth_bounded_by: "raw_events_retention",
          retention_days: retentionDays,
        },
      }),
    );
    return undefined;
  };
}

export const profilesRebuildCommand: CommandDefinition = {
  id: "profiles.rebuild",
  mutates: true,
  register: (parent, deps) => {
    parent
      .command("rebuild")
      .description("Truncate and rebuild a project's profile plane from raw.events")
      .requiredOption("--project <id>")
      .requiredOption("--env <environment>")
      .requiredOption("--reason <text>", "why this rebuild is being run (audited)")
      .option("--yes", "confirm the truncate")
      .action(async (opts: ProfilesRebuildArgs, command: Command) => {
        const wrapped = deps.runCommand<ProfilesRebuildArgs>(
          { id: "profiles.rebuild", mutates: true },
          buildProfilesRebuildRunner({ driver: buildRegisteredRebuildDriver }),
        );
        await wrapped(opts, command);
      });
  },
};
