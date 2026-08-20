/**
 * Day-partitioned Parquet exports, driven by ClickHouse itself.
 *
 * `INSERT INTO FUNCTION s3(...) FORMAT Parquet` — the server reads its
 * own tables and writes the object. Nothing streams through Node, which
 * is the stack rule (plan §8.1) and also the only version that works: a
 * day of a busy project's events is gigabytes, and a Node process that
 * pulled them to re-encode would be a memory limit waiting to happen.
 *
 * ## Why this is a sanctioned method and not `raw.query`
 *
 * The escape hatch exists, is audited, and would have been faster to
 * write. But an export that reached for it would be an export whose
 * dedupe correctness lived at the call site — and the one thing a
 * warehouse extract must not do is ship the duplicates a
 * ReplacingMergeTree holds between merges. The argMax projection is
 * built here, once, from the same helper the replay readers use, so an
 * export cannot be written that forgets it. `FINAL` is rejected by the
 * same assertion for the same reason.
 *
 * ## Reruns overwrite
 *
 * `s3_truncate_on_insert=1`, and the object key is a pure function of
 * `(dataset, project, environment, day)`. A cron that retries after a
 * partial failure replaces the day's object rather than appending a
 * second copy of half of it — which is what "idempotent" has to mean for
 * a file, since there is no key to collapse on afterwards.
 *
 * ## The profiles snapshot carries the merge map
 *
 * A profiles extract without it is a snapshot whose keys silently stop
 * resolving: a merged profile's events live under the loser's id, and
 * offline readers have no dictionary to redirect them. Exported as its
 * own dataset so a reader joins the two, which is exactly what
 * `dictGetOrDefault('polaris.profile_canonical', ...)` does online.
 */

import type { ClickHouseClient as UnderlyingClickHouseClient } from "@clickhouse/client";
import { ClickHouseInvariantError } from "./errors.js";
import { argMaxProjection, assertNoFinal, sumProjection } from "./internal/sql.js";

/**
 * Datasets `polaris warehouse export` can write.
 *
 * A closed set, and it stays closed. §6.2 asks for "Parquet snapshots of
 * the projection tables and `analytics_raw` slices", which reads like an
 * argument for an open `--table` flag — but every entry below needs a
 * hand-written SELECT that is correct for its storage engine, and a verb
 * that took a table name would be a verb that skips that. The three
 * projections were the missing half of the promise; they are added as
 * datasets, not as a parameter.
 *
 * Two engines, two dedupe idioms, and using the wrong one returns a
 * number rather than an error:
 *
 *   ReplacingMergeTree   events, profiles, merge_map      argMax by version
 *   SummingMergeTree     the three *_daily_* projections  sum
 *
 * The projection names match `READABLE_PROJECTIONS` in `definitions/traits`
 * and `ALLOWED_TABLES` in `lint-trait-sql.mjs` — the same three tables a
 * computed trait may read, which is not a coincidence: they are the
 * tables that exist to be read by something other than the pipeline.
 */
export const WAREHOUSE_DATASETS = [
  "events",
  "profiles",
  "merge_map",
  "event_daily_counts",
  "session_daily_metrics",
  "profile_event_daily_counts",
] as const;
export type WarehouseDataset = (typeof WAREHOUSE_DATASETS)[number];

export function isWarehouseDataset(value: string): value is WarehouseDataset {
  return (WAREHOUSE_DATASETS as readonly string[]).includes(value);
}

/** Where the export lands, and how to authenticate to it. */
export interface WarehouseExportTarget {
  /**
   * Bucket URL WITHOUT the object key — e.g.
   * `https://s3.eu-west-1.amazonaws.com/polaris-warehouse`. The key is
   * appended from the layout below, so a caller cannot pick a path that
   * a later reader would fail to find.
   */
  readonly bucketUrl: string;
  readonly accessKeyId?: string | undefined;
  readonly secretAccessKey?: string | undefined;
}

export interface WarehouseExportRequest {
  readonly dataset: WarehouseDataset;
  readonly projectId: string;
  readonly environment: string;
  /** `YYYY-MM-DD`, UTC. The day the events occurred, not the run's day. */
  readonly day: string;
  readonly target: WarehouseExportTarget;
}

export interface WarehouseExportResult {
  readonly dataset: WarehouseDataset;
  readonly objectUrl: string;
  /** Rows ClickHouse reported writing. */
  readonly rows: number;
  readonly bytes: number;
}

export interface WarehouseExporter {
  export(request: WarehouseExportRequest): Promise<WarehouseExportResult>;
}

/**
 * Object key for one export.
 *
 * `dataset/project/environment/day.parquet`. Dataset first because a
 * lifecycle rule or an external loader is configured per dataset — a
 * Spark job reading `events/` should not have to enumerate projects to
 * find them, and a retention policy on profiles snapshots should not
 * catch the event slices.
 */
function warehouseObjectKey(input: {
  readonly dataset: WarehouseDataset;
  readonly projectId: string;
  readonly environment: string;
  readonly day: string;
}): string {
  assertDay(input.day);
  return `${input.dataset}/${assertSegment(input.projectId, "project_id")}/${assertSegment(
    input.environment,
    "environment",
  )}/${input.day}.parquet`;
}

export function createWarehouseExporter(input: {
  readonly underlying: UnderlyingClickHouseClient;
}): WarehouseExporter {
  return {
    async export(request): Promise<WarehouseExportResult> {
      const key = warehouseObjectKey(request);
      const objectUrl = `${request.target.bucketUrl.replace(/\/+$/, "")}/${key}`;
      const select = selectFor(request);
      assertNoFinal(select, `warehouse export (${request.dataset})`);

      // Credentials are positional in ClickHouse's `s3()` signature and
      // cannot be bound as query parameters, so the two-arg form is used
      // when they are absent — which is the shape a deployment using an
      // instance role wants anyway.
      const s3Args =
        request.target.accessKeyId !== undefined && request.target.secretAccessKey !== undefined
          ? "{url:String}, {access_key:String}, {secret_key:String}, 'Parquet'"
          : "{url:String}, 'Parquet'";

      const result = await input.underlying.query({
        query: `
          INSERT INTO FUNCTION s3(${s3Args})
          ${select}
        `,
        query_params: {
          url: objectUrl,
          project: request.projectId,
          environment: request.environment,
          day: request.day,
          ...(request.target.accessKeyId !== undefined
            ? { access_key: request.target.accessKeyId }
            : {}),
          ...(request.target.secretAccessKey !== undefined
            ? { secret_key: request.target.secretAccessKey }
            : {}),
        },
        clickhouse_settings: {
          // A rerun replaces the day rather than appending half of it
          // again. There is no key to collapse on once it is a file.
          s3_truncate_on_insert: 1,
        },
      });

      const summary = readSummary(result);
      return { dataset: request.dataset, objectUrl, rows: summary.rows, bytes: summary.bytes };
    },
  };
}

/**
 * The SELECT each dataset exports.
 *
 * Every one is scoped to a single `(project, environment, day)` by bound
 * parameter — an export is a per-project extract, and a query that could
 * be widened at the call site would be one project's operator reading
 * another's data through a legitimate verb.
 */
function selectFor(request: WarehouseExportRequest): string {
  switch (request.dataset) {
    case "events":
      // The dedupe idiom, not raw rows. Between merges a
      // ReplacingMergeTree holds every duplicate, and an extract that
      // shipped them would make every downstream count wrong in a way
      // that looks like real traffic.
      return `
        SELECT
          project_id,
          environment,
          event,
          event_id,
          ${argMaxProjection([...EVENT_EXPORT_COLUMNS])}
        FROM polaris.analytics_raw
        WHERE project_id = {project:String}
          AND environment = {environment:String}
          -- Table-qualified. An unqualified occurred_at here resolves to
          -- the argMax alias in the SELECT list, and ClickHouse rejects
          -- an aggregate in WHERE -- a failure that appears only when the
          -- query runs against a real server.
          AND toDate(analytics_raw.occurred_at) = toDate({day:String})
        GROUP BY project_id, environment, event, event_id
      `;

    case "profiles":
      // One row per (profile, trait) -- the shape `polaris.profiles`
      // actually holds. `profile.updated` carries changed keys only, so
      // the table keys on `trait_key` and an update touches exactly the
      // keys it names.
      //
      // This read the Map shape briefly, because 36_profiles.sql still
      // described one: the table's DDL and its own materialized view had
      // disagreed since they shipped, and the file was the thing I
      // checked. Applying the schema is what settled it.
      //
      // `removed = 0` filters the tombstones: a trait going away is an
      // update with a higher `traits_version`, not a delete, and an
      // extract carrying tombstones would report absent traits as present
      // with an empty value.
      return `
        SELECT
          project_id,
          environment,
          profile_id,
          trait_key,
          argMax(value, traits_version) AS value,
          -- Aliased away from the column name; naming an aggregate's
          -- output after its own argument makes ClickHouse resolve the
          -- alias back into it and reject the query.
          max(traits_version) AS max_traits_version,
          argMax(updated_at, traits_version) AS updated_at
        FROM polaris.profiles
        WHERE project_id = {project:String}
          AND environment = {environment:String}
        GROUP BY project_id, environment, profile_id, trait_key
        HAVING argMax(removed, traits_version) = 0
      `;

    case "merge_map":
      // Whole map, not a day's slice: a merge recorded years ago still
      // governs how today's events resolve, so a day-scoped export would
      // hand a reader a dictionary missing most of its entries.
      return `
        SELECT
          project_id,
          environment,
          loser_profile_id,
          argMax(winner_profile_id, _version) AS winner_profile_id,
          argMax(reason, _version) AS reason,
          -- Aliased away from the column name; see the profiles dataset.
          max(_version) AS max_version
        FROM polaris.profile_merge_map
        WHERE project_id = {project:String}
          AND environment = {environment:String}
        GROUP BY project_id, environment, loser_profile_id
      `;

    // ---- the projections ------------------------------------------------
    // SummingMergeTree, so `sum` and not `argMax`: the engine's unmerged
    // parts are ADDENDS of one day's count, not older versions of it.
    // Selecting them raw would split one day's traffic across several
    // rows that each look like a plausible smaller day.

    case "event_daily_counts":
      return `
        SELECT
          project_id,
          environment,
          event,
          occurred_date,
          ${sumProjection(["event_count"])}
        FROM polaris.event_daily_counts
        WHERE project_id = {project:String}
          AND environment = {environment:String}
          AND occurred_date = toDate({day:String})
        GROUP BY project_id, environment, event, occurred_date
      `;

    case "session_daily_metrics":
      return `
        SELECT
          project_id,
          environment,
          occurred_date,
          ${sumProjection(["sessions_started", "sessions_ended"])}
        FROM polaris.session_daily_metrics
        WHERE project_id = {project:String}
          AND environment = {environment:String}
          AND occurred_date = toDate({day:String})
        GROUP BY project_id, environment, occurred_date
      `;

    case "profile_event_daily_counts":
      // `customer_id` is not in the table's sort key
      // (project_id, environment, profile_id, event, occurred_date), so the
      // engine already keeps an arbitrary one of the collapsed values.
      // `any()` matches that rather than pretending otherwise: grouping BY
      // it would emit more rows than the table logically holds whenever a
      // profile's customer_id changed.
      return `
        SELECT
          project_id,
          environment,
          profile_id,
          any(customer_id) AS customer_id,
          event,
          occurred_date,
          ${sumProjection(["event_count"])}
        FROM polaris.profile_event_daily_counts
        WHERE project_id = {project:String}
          AND environment = {environment:String}
          AND occurred_date = toDate({day:String})
        GROUP BY project_id, environment, profile_id, event, occurred_date
      `;

    default: {
      // Exhaustive: a dataset added to the closed set without a SELECT
      // here fails loudly rather than exporting an empty object.
      const unreachable: never = request.dataset;
      throw new ClickHouseInvariantError(`warehouse export: no SELECT for dataset ${unreachable}`);
    }
  }
}

/**
 * Columns the events extract carries.
 *
 * Deliberately the same set the replay reader projects: an extract that
 * carried fewer would make the warehouse and the replay path disagree
 * about what an event IS, and the difference would only surface when
 * somebody tried to reconcile them.
 */
const EVENT_EXPORT_COLUMNS = [
  "schema_version",
  "occurred_at",
  "ingested_at",
  "source_id",
  "source_type",
  "sdk",
  "sdk_version",
  "anonymous_id",
  "session_id",
  "customer_id",
  "device_id",
  "ip",
  "user_agent",
  "locale",
  "properties_json",
  "context_json",
  "consent_json",
  "privacy_json",
  "processor_name",
  "processor_version",
] as const;

interface ExportSummary {
  readonly rows: number;
  readonly bytes: number;
}

/**
 * Rows and bytes from the INSERT's summary.
 *
 * Reported by ClickHouse in the `X-ClickHouse-Summary` header, surfaced
 * by the client as `response_headers`. Absent on some versions, and a
 * zero there means "not reported" rather than "nothing written" — which
 * is why the CLI prints it as a number and not as a success condition.
 */
function readSummary(result: unknown): ExportSummary {
  const summary = (result as { summary?: { written_rows?: string; written_bytes?: string } })
    .summary;
  return {
    rows: Number(summary?.written_rows ?? 0),
    bytes: Number(summary?.written_bytes ?? 0),
  };
}

function assertDay(day: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new ClickHouseInvariantError(`warehouse export day must be YYYY-MM-DD (got "${day}")`);
  }
}

/**
 * Refuse a path segment that could escape the layout.
 *
 * Project ids and environments are validated by the control plane long
 * before they reach here, so this is defense in depth — but the value
 * becomes part of an object key, and a `../` in one would write outside
 * the prefix a bucket policy scopes a role to.
 */
function assertSegment(value: string, label: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
    throw new ClickHouseInvariantError(
      `warehouse export ${label} must be alphanumeric with . _ - (got "${value}")`,
    );
  }
  return value;
}
