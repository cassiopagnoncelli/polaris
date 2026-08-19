/**
 * `polaris warehouse export --project X --env Y --day 2026-08-15`
 *
 * Scheduled warehouse loads. ClickHouse writes the Parquet itself —
 * `INSERT INTO FUNCTION s3(...)` — so nothing streams through this
 * process; the command's whole job is to say which slice, check the
 * answer, and fail loudly enough for cron to notice.
 *
 * ## Failing loudly is the feature
 *
 * A nightly export that swallows its own failure is a warehouse that
 * silently stops receiving data, and the first person to notice is an
 * analyst asking why last week is missing. So: no `|| true` in the
 * crontab example, a non-zero exit on any failure, and a job record on
 * every run including the failed ones.
 *
 * ## Datasets
 *
 * The facts, on ReplacingMergeTree — deduped by the argMax idiom, never
 * raw rows, because between merges the engine holds every duplicate and
 * an extract that shipped them would make downstream counts wrong in a
 * way that looks like real traffic:
 *
 *   events     — `analytics_raw` for the day.
 *   profiles   — current trait state per profile.
 *   merge_map  — the whole merge map, so canonical resolution works
 *                offline. Exported alongside `profiles` by default,
 *                because a profiles snapshot without it is one whose
 *                keys silently stop resolving.
 *
 * The projections, on SummingMergeTree — summed rather than argMax'd,
 * because this engine's unmerged parts are ADDENDS of one day's number
 * rather than older versions of it. Using the fact tables' idiom here
 * would return a number, not an error:
 *
 *   event_daily_counts          — per (event, day).
 *   session_daily_metrics       — sessions started/ended per day.
 *   profile_event_daily_counts  — the person-dimensioned one.
 *
 * These are the same three tables a computed trait may read. They exist
 * to be read by something other than the pipeline, which is exactly the
 * argument for exporting them.
 *
 * `--dataset` narrows to one; omitted, the command writes all six.
 *
 * ## Day is the EVENTS' day, not the run's
 *
 * A job that runs at 02:00 exports yesterday, and an operator
 * backfilling March passes March. `--day` is therefore required rather
 * than defaulted: a default of "yesterday" reads correctly in a crontab
 * and wrongly in every manual invocation made to fix something.
 *
 * `mutates: false`: this writes to object storage, not to Polaris. It
 * reads ClickHouse and produces a file, and nothing in the platform
 * changes state — so the production gate from P6-007 does not apply.
 */

import {
  createClickHouseClient,
  isWarehouseDataset,
  WAREHOUSE_DATASETS,
  type WarehouseDataset,
  type WarehouseExportResult,
  type WarehouseExportTarget,
} from "@polaris/shared-clickhouse";
import { v7 as uuidv7 } from "uuid";

import type { CommandContext, CommandDefinition } from "../../command.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";

const CLICKHOUSE_URL_ENV = "POLARIS_CLICKHOUSE_URL";
const CLICKHOUSE_USER_ENV = "POLARIS_CLICKHOUSE_OPERATOR_USER";
const CLICKHOUSE_PASSWORD_ENV = "POLARIS_CLICKHOUSE_OPERATOR_PASSWORD";
const BUCKET_ENV = "POLARIS_WAREHOUSE_BUCKET_URL";
const ACCESS_KEY_ENV = "POLARIS_WAREHOUSE_S3_ACCESS_KEY_ID";
const SECRET_KEY_ENV = "POLARIS_WAREHOUSE_S3_SECRET_ACCESS_KEY";

interface WarehouseExportArgs {
  readonly project?: string;
  readonly env?: string;
  readonly day?: string;
  readonly dataset?: string;
}

/** One dataset's outcome, as the job record carries it. */
export interface WarehouseExportJobEntry {
  readonly dataset: WarehouseDataset;
  readonly status: "written" | "failed";
  readonly object_url?: string;
  readonly rows?: number;
  readonly bytes?: number;
  readonly error?: string;
}

export interface WarehouseExportJob {
  readonly job_id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly day: string;
  readonly datasets: readonly WarehouseExportJobEntry[];
  readonly status: "completed" | "failed";
}

export interface WarehouseExportStore {
  exportDataset(input: {
    readonly dataset: WarehouseDataset;
    readonly projectId: string;
    readonly environment: string;
    readonly day: string;
    readonly target: WarehouseExportTarget;
  }): Promise<WarehouseExportResult>;
  close(): Promise<void>;
}

export interface WarehouseExportHooks {
  readonly openStore?: (ctx: CommandContext) => WarehouseExportStore;
  readonly target?: (ctx: CommandContext) => WarehouseExportTarget;
  readonly generateJobId?: () => string;
  readonly recordJob?: (ctx: CommandContext, job: WarehouseExportJob) => void;
}

export function buildWarehouseExportRunner(hooks: WarehouseExportHooks = {}) {
  const generateJobId = hooks.generateJobId ?? (() => `polaris_wxj_${uuidv7()}`);

  return async function runner(args: WarehouseExportArgs, ctx: CommandContext): Promise<undefined> {
    const projectId = requireArg(args.project, "--project");
    const environment = requireArg(args.env, "--env");
    const day = requireArg(args.day, "--day");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      throw new UsageError(`--day must be YYYY-MM-DD (got "${day}")`);
    }

    const datasets = resolveDatasets(args.dataset);
    const target = (hooks.target ?? defaultTarget)(ctx);
    const store = (hooks.openStore ?? defaultStore)(ctx);
    const jobId = generateJobId();
    const entries: WarehouseExportJobEntry[] = [];

    try {
      for (const dataset of datasets) {
        try {
          const result = await store.exportDataset({
            dataset,
            projectId,
            environment,
            day,
            target,
          });
          entries.push({
            dataset,
            status: "written",
            object_url: result.objectUrl,
            rows: result.rows,
            bytes: result.bytes,
          });
        } catch (err) {
          // Recorded and carried on. One dataset failing must not hide
          // whether the others landed — an operator triaging a partial
          // night needs to know which slice to re-run, and a throw here
          // would leave the earlier successes unreported.
          entries.push({
            dataset,
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      await store.close();
    }

    const failed = entries.filter((entry) => entry.status === "failed");
    const job: WarehouseExportJob = {
      job_id: jobId,
      project_id: projectId,
      environment,
      day,
      datasets: entries,
      status: failed.length > 0 ? "failed" : "completed",
    };
    (hooks.recordJob ?? defaultRecordJob)(ctx, job);

    emit(ctx, job);

    if (failed.length > 0) {
      // Non-zero exit, so cron sees it. The job record above is already
      // written — the failure is reported, not swallowed, and the
      // datasets that DID land are named in it.
      throw new UsageError(
        `warehouse export ${jobId} failed for ${failed.length} of ${String(
          entries.length,
        )} dataset(s): ${failed.map((entry) => `${entry.dataset} (${entry.error ?? "unknown"})`).join("; ")}`,
      );
    }
    return undefined;
  };
}

export const warehouseExportCommand: CommandDefinition = {
  id: "warehouse.export",
  mutates: false,
  register: (parent, deps) => {
    parent
      .command("export")
      .description(
        "Write day-partitioned Parquet to the warehouse bucket. ClickHouse performs the " +
          `export natively. Datasets: ${WAREHOUSE_DATASETS.join(", ")}.`,
      )
      .requiredOption("--project <id>")
      .requiredOption("--env <environment>")
      .requiredOption("--day <YYYY-MM-DD>", "the day the EVENTS occurred, not the run's day")
      .option("--dataset <name>", `One of: ${WAREHOUSE_DATASETS.join(", ")}. Default: all.`)
      .action(
        deps.runCommand({ id: "warehouse.export", mutates: false }, buildWarehouseExportRunner()),
      );
  },
};

function requireArg(value: string | undefined, flag: string): string {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    throw new UsageError(`${flag} is required`);
  }
  return trimmed;
}

function resolveDatasets(requested: string | undefined): readonly WarehouseDataset[] {
  const trimmed = requested?.trim();
  if (trimmed === undefined || trimmed.length === 0) return WAREHOUSE_DATASETS;
  if (!isWarehouseDataset(trimmed)) {
    throw new UsageError(
      `--dataset must be one of: ${WAREHOUSE_DATASETS.join(", ")} (got "${trimmed}")`,
    );
  }
  return [trimmed];
}

function defaultTarget(ctx: CommandContext): WarehouseExportTarget {
  const bucketUrl = ctx.env[BUCKET_ENV]?.trim();
  if (bucketUrl === undefined || bucketUrl.length === 0) {
    throw new UsageError(
      `${BUCKET_ENV} is required: it is the bucket ClickHouse writes the Parquet to.`,
    );
  }
  const accessKeyId = ctx.env[ACCESS_KEY_ENV]?.trim();
  const secretAccessKey = ctx.env[SECRET_KEY_ENV]?.trim();
  return {
    bucketUrl,
    // Both or neither. Half a credential pair produces an S3 error from
    // deep inside ClickHouse that says nothing about which half is
    // missing, and an unset pair is the correct shape for a deployment
    // using an instance role.
    ...(accessKeyId !== undefined && accessKeyId.length > 0 ? { accessKeyId } : {}),
    ...(secretAccessKey !== undefined && secretAccessKey.length > 0 ? { secretAccessKey } : {}),
  };
}

function defaultStore(ctx: CommandContext): WarehouseExportStore {
  const url = ctx.env[CLICKHOUSE_URL_ENV];
  if (url === undefined || url.trim().length === 0) {
    throw new UsageError(`${CLICKHOUSE_URL_ENV} is required: the export reads ClickHouse.`);
  }
  const client = createClickHouseClient({
    url,
    // OPERATOR, not service. The events dataset reads the raw tier, which
    // the service role has no SELECT grant on — the same boundary the
    // replay readers sit behind.
    role: "operator",
    credential: {
      username: ctx.env[CLICKHOUSE_USER_ENV] ?? "polaris_operator",
      password: ctx.env[CLICKHOUSE_PASSWORD_ENV] ?? "",
    },
    database: "polaris",
    application: "polaris-warehouse-export",
  });
  return {
    exportDataset: (input) => client.warehouse.export(input),
    close: () => client.close(),
  };
}

/**
 * Logged rather than tabled, matching `profiles rebuild`.
 *
 * There is no `warehouse_export_jobs` table and adding one to carry a
 * row a night would be schema for its own sake. The line carries the job
 * id, the datasets and their outcomes, which is what a cron log or a log
 * aggregator needs to answer "did last night land?".
 */
function defaultRecordJob(ctx: CommandContext, job: WarehouseExportJob): void {
  ctx.logger.info({ audit_action: "warehouse.export", ...job }, "warehouse export finished");
}

function emit(ctx: CommandContext, job: WarehouseExportJob): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: [
        `export ${job.job_id}: ${job.status}`,
        `scope   ${job.project_id}/${job.environment} ${job.day}`,
        "",
        ...job.datasets.map((entry) =>
          entry.status === "written"
            ? `  ${entry.dataset.padEnd(10)} ${String(entry.rows ?? 0).padStart(10)} rows  ${
                entry.object_url ?? ""
              }`
            : `  ${entry.dataset.padEnd(10)} FAILED     ${entry.error ?? "unknown"}`,
        ),
      ].join("\n"),
      json: job,
    }),
  );
}
