/**
 * `polaris reverse-etl run <job> --project X --env Y`
 *
 * A run, not a daemon. Reads the job's SQL against the projections, maps
 * rows to canonical events, and POSTs them to the ingester.
 *
 * ## The key is a project-config secret
 *
 * The runner authenticates like any other producer, with an API key
 * issued for an INTERNAL source. It reads that key from project config
 * under `reverse_etl.ingest_api_key`, which is an `is_secret` value —
 * so it is set with `polaris config set --secret`, never printed back,
 * and never lands in a crontab where `ps` would show it.
 *
 * Provisioning, once per project:
 *
 *   polaris sources create --project X --env Y \
 *     --id reverse-etl --type job
 *   polaris keys create --project X --env Y \
 *     --source reverse-etl --type job
 *   polaris config set --project X --env Y \
 *     --key reverse_etl.ingest_api_key --secret --value <token>
 *
 * ## Exit code is the contract with cron
 *
 * Non-zero when the ingester rejected anything. A nightly writeback that
 * exits 0 having had every event refused is a trait that silently stopped
 * updating, and the first person to notice is a marketer asking why a
 * campaign is targeting the wrong people.
 *
 * `mutates: true`: this writes events into the platform.
 */

import {
  type IngestBatchResult,
  jobEnabled,
  PROJECT_CONFIG_NAMESPACE,
  type ReverseEtlRunResult,
  runReverseEtl,
} from "@polaris/processor-reverse-etl-v1";
import {
  findReverseEtlJob,
  REVERSE_ETL_JOBS,
  type ReverseEtlRow,
} from "@polaris/reverse-etl-catalog";
import { deriveEventId } from "@polaris/pipeline";
import type { Command } from "commander";
import { v7 as uuidv7 } from "uuid";

import type { CommandContext, CommandDefinition } from "../../command.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import { buildRegisteredReverseEtlHooks } from "./registration.js";

/** Events per POST. Under the ingester's default batch ceiling. */
const DEFAULT_BATCH_SIZE = 100;

interface ReverseEtlRunArgs {
  readonly job?: string;
  readonly project?: string;
  readonly env?: string;
  readonly batchSize?: string;
}

export interface ReverseEtlRunHooks {
  readonly query?: (ctx: CommandContext) => {
    run(input: {
      sql: string;
      projectId: string;
      environment: string;
    }): Promise<readonly ReverseEtlRow[]>;
    close(): Promise<void>;
  };
  readonly ingest?: (
    ctx: CommandContext,
    scope: { projectId: string; environment: string },
  ) => { send(events: readonly Record<string, unknown>[]): Promise<IngestBatchResult> };
  readonly now?: () => Date;
  readonly generateRunId?: () => string;
  /**
   * This project's `reverse_etl` config slice, for the enablement check.
   *
   * A hook rather than a direct read so the check is testable without a
   * control plane — and absent means "no control plane wired", which is
   * the shape a `--dry-run` or a unit test has. Absent is treated as no
   * restriction, exactly as an unset key is.
   */
  readonly readProjectConfig?: (
    ctx: CommandContext,
    scope: { projectId: string; environment: string },
  ) => Promise<Readonly<Record<string, unknown>>>;
}

export function buildReverseEtlRunRunner(hooks: ReverseEtlRunHooks = {}) {
  return async function runner(args: ReverseEtlRunArgs, ctx: CommandContext): Promise<undefined> {
    const key = args.job?.trim();
    if (key === undefined || key.length === 0) throw new UsageError("job name is required");
    const job = findReverseEtlJob(key);
    if (job === undefined) {
      // Names the registry rather than saying "not found": a typo and an
      // unshipped job look identical to an operator otherwise.
      throw new UsageError(
        `unknown reverse-etl job "${key}". Registered: ${REVERSE_ETL_JOBS.map((j) => j.key).join(", ")}`,
      );
    }
    const projectId = requireArg(args.project, "--project");
    const environment = requireArg(args.env, "--env");
    const batchSize = parseBatchSize(args.batchSize);

    // Enablement, before any client is built. A disabled job should not
    // open a ClickHouse connection to discover it has nothing to do.
    //
    // Exit ZERO when skipped. Cron treats non-zero as "wake somebody up",
    // and a job an operator deliberately switched off is not an incident —
    // the failure this command's non-zero rule exists for is a run that
    // was SUPPOSED to happen and did not.
    if (hooks.readProjectConfig !== undefined) {
      const slice = await hooks.readProjectConfig(ctx, { projectId, environment });
      const verdict = jobEnabled(job.key, slice);
      if (!verdict.enabled) {
        ctx.logger.info(
          {
            audit_action: "reverse_etl.skipped",
            job: job.key,
            projectId,
            environment,
            reason: verdict.reason,
          },
          "reverse-etl job not enabled for this project",
        );
        ctx.output.writeOut(
          renderAccordingTo(ctx.config.output, {
            human:
              `skipped: ${job.key} is not enabled for ${projectId}/${environment}\n` +
              `  ${verdict.reason ?? ""}\n` +
              `  enable it: polaris config set --project ${projectId} --env ${environment} ` +
              `--key ${PROJECT_CONFIG_NAMESPACE}.enabled_jobs --value '["${job.key}"]'\n`,
            json: {
              status: "skipped",
              job: job.key,
              project_id: projectId,
              environment,
              reason: verdict.reason,
            },
          }),
        );
        return undefined;
      }
    }

    if (hooks.query === undefined || hooks.ingest === undefined) {
      // Reachable only from a caller that built the runner without hooks.
      // Refusing beats pretending: a command that read no rows and posted
      // nothing would exit 0 and read as a successful run.
      throw new UsageError("reverse-etl run has no query or ingest client configured");
    }

    const runId = (hooks.generateRunId ?? (() => `polaris_rtl_${uuidv7()}`))();
    const query = hooks.query(ctx);
    let result: ReverseEtlRunResult;
    try {
      result = await runReverseEtl({
        job,
        projectId,
        environment,
        query,
        ingest: hooks.ingest(ctx, { projectId, environment }),
        runId,
        now: hooks.now ?? (() => new Date()),
        batchSize,
        // The platform's UUIDv5 derivation, keyed on the job and the
        // PAYLOAD — so an unchanged row reruns to the same id and the
        // ingester's dedupe window absorbs it.
        deriveId: ({ job: jobKey, version, customerId, properties }) =>
          deriveEventId({
            processor: "reverse-etl",
            sourceEventId: `${jobKey}:${String(version)}:${customerId}`,
            slot: stableStringify(properties),
          }),
      });
    } finally {
      await query.close();
    }

    // Logged rather than tabled, matching `profiles rebuild` and
    // `warehouse export`: there is no runs table, and the line carries
    // what a cron log needs to answer "did last night land?".
    ctx.logger.info(
      {
        audit_action: "reverse_etl.run",
        run_id: runId,
        job: job.key,
        projectId,
        environment,
        ...result,
      },
      "reverse-etl run finished",
    );

    ctx.output.writeOut(
      renderAccordingTo(ctx.config.output, {
        human:
          `run ${runId}: ${job.key} v${String(job.version)} ${projectId}/${environment}\n` +
          `  rows ${String(result.rowsRead)} (skipped ${String(result.rowsSkipped)})  ` +
          `sent ${String(result.eventsSent)}  accepted ${String(result.eventsAccepted)}  ` +
          `rejected ${String(result.eventsRejected)}` +
          (result.rejectedReasons.length > 0
            ? `\n  reasons: ${result.rejectedReasons.join(", ")}`
            : ""),
        json: { run_id: runId, job: job.key, version: job.version, ...result },
      }),
    );

    if (result.eventsRejected > 0) {
      throw new UsageError(
        `reverse-etl run ${runId} had ${String(result.eventsRejected)} event(s) rejected: ` +
          result.rejectedReasons.join(", "),
      );
    }
    return undefined;
  };
}

export const reverseEtlRunCommand: CommandDefinition = {
  id: "reverse-etl.run",
  mutates: true,
  register: (parent, deps) => {
    parent
      .command("run <job>")
      .description(
        `Run a reverse-ETL job. Registered: ${REVERSE_ETL_JOBS.map((j) => j.key).join(", ")}.`,
      )
      .requiredOption("--project <id>")
      .requiredOption("--env <environment>")
      .option(
        "--batch-size <n>",
        `Events per POST (1..1000, default ${String(DEFAULT_BATCH_SIZE)}).`,
      )
      // Hooks supplied HERE, not omitted. A registration whose runner has
      // no query or ingest client refuses at runtime with "no query or
      // ingest client configured" — this repo has shipped that shape twice
      // and both times the command was unusable in production while every
      // test passed.
      .action(async (job: string, opts: Record<string, unknown>, command: Command) => {
        const wrapped = deps.runCommand<ReverseEtlRunArgs>(
          { id: "reverse-etl.run", mutates: true },
          buildReverseEtlRunRunner(buildRegisteredReverseEtlHooks()),
        );
        await wrapped({ job, ...(opts as Omit<ReverseEtlRunArgs, "job">) }, command);
      });
  },
};

function requireArg(value: string | undefined, flag: string): string {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) throw new UsageError(`${flag} is required`);
  return trimmed;
}

function parseBatchSize(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_BATCH_SIZE;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1000) {
    throw new UsageError(`--batch-size must be between 1 and 1000 (got "${raw}")`);
  }
  return parsed;
}

/**
 * Key-sorted JSON, so the derived id does not depend on property order.
 *
 * `JSON.stringify` preserves insertion order, and a mapping that built
 * its object differently on two runs — a conditional field, a spread —
 * would produce a different id for identical data and defeat the dedupe.
 */
function stableStringify(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
}
