/**
 * The reverse-ETL runner.
 *
 * Reads a job's SQL against the projections, maps each row to a canonical
 * event, and POSTs the events to the INGESTER — not to `raw.events`.
 *
 * ## Through the front door, always
 *
 * Publishing straight to the stream would skip envelope validation, the
 * forbidden-field policy, the dedupe window and the per-key rate limiter:
 * every guarantee the platform makes about what enters it. The plan
 * forbids it (SS12) and this module has no producer to do it with.
 *
 * The cost is real — an HTTP hop for data already inside the building —
 * and it is the point. A warehouse row is not more trustworthy than an
 * SDK's payload just because it came from a database; if anything it is
 * less, having been through a transformation nobody in Polaris reviewed.
 *
 * ## Dedupe is what makes a rerun free
 *
 * `event_id` is derived from the job, its version, the customer and the
 * PROPERTIES — so a rerun over unchanged rows produces the same ids, and
 * the ingester's dedupe window absorbs them. A row whose value changed
 * gets a different id and flows. That is the behaviour a cron needs: run
 * it twice by accident and nothing happens; run it after the number moved
 * and the new number arrives.
 *
 * Deriving from the RUN instead would make every rerun a fresh write, and
 * a job scheduled hourly over a slow-moving aggregate would emit the same
 * fact twenty-four times a day.
 *
 * ## One event at a time, on purpose
 *
 * The ingester accepts batches and this sends them, but the runner does
 * not parallelise: it is a cron job competing with live traffic for the
 * same per-key rate limit. Finishing in four minutes instead of two while
 * leaving the limiter alone for real producers is the correct trade.
 */

import type { ReverseEtlJob, ReverseEtlMapped, ReverseEtlRow } from "@polaris/reverse-etl-catalog";

/** Reads a job's SQL. Same shape the traits runner uses. */
export interface ReverseEtlQueryRunner {
  run(input: {
    readonly sql: string;
    readonly projectId: string;
    readonly environment: string;
  }): Promise<readonly ReverseEtlRow[]>;
}

/** One batch, as the ingester answers it. */
export interface IngestBatchResult {
  readonly accepted: number;
  readonly rejected: number;
  /** Reason codes, for the run record. Never payloads. */
  readonly rejectedReasons: readonly string[];
}

/** POSTs to the ingester. The transport lives in the CLI's wiring. */
export interface ReverseEtlIngestClient {
  send(events: readonly Record<string, unknown>[]): Promise<IngestBatchResult>;
}

export interface ReverseEtlRunInput {
  readonly job: ReverseEtlJob;
  readonly projectId: string;
  readonly environment: string;
  readonly query: ReverseEtlQueryRunner;
  readonly ingest: ReverseEtlIngestClient;
  readonly runId: string;
  readonly now: () => Date;
  /** Events per POST. */
  readonly batchSize: number;
  /**
   * Derives an event id from a mapping. Injected so the CLI supplies the
   * platform's UUIDv5 derivation and tests can assert determinism without
   * reimplementing it.
   */
  readonly deriveId: (input: {
    readonly job: string;
    readonly version: number;
    readonly customerId: string;
    readonly properties: Readonly<Record<string, unknown>>;
  }) => string;
}

export interface ReverseEtlRunResult {
  readonly rowsRead: number;
  readonly rowsSkipped: number;
  readonly eventsSent: number;
  readonly eventsAccepted: number;
  readonly eventsRejected: number;
  readonly rejectedReasons: readonly string[];
}

export async function runReverseEtl(input: ReverseEtlRunInput): Promise<ReverseEtlRunResult> {
  const rows = await input.query.run({
    sql: input.job.sql,
    projectId: input.projectId,
    environment: input.environment,
  });

  let skipped = 0;
  const events: Record<string, unknown>[] = [];
  for (const row of rows) {
    const mapped = input.job.toEvent(row);
    if (mapped === null) {
      // A job over a million rows will meet a few it cannot map. Counted,
      // never fatal: one null customer id must not fail a nightly run.
      skipped += 1;
      continue;
    }
    events.push(toEnvelope(mapped, input));
  }

  let accepted = 0;
  let rejected = 0;
  const reasons = new Set<string>();
  for (let index = 0; index < events.length; index += input.batchSize) {
    const batch = events.slice(index, index + input.batchSize);
    const result = await input.ingest.send(batch);
    accepted += result.accepted;
    rejected += result.rejected;
    for (const reason of result.rejectedReasons) reasons.add(reason);
  }

  return {
    rowsRead: rows.length,
    rowsSkipped: skipped,
    eventsSent: events.length,
    eventsAccepted: accepted,
    eventsRejected: rejected,
    rejectedReasons: [...reasons].sort(),
  };
}

/**
 * The canonical envelope a mapping becomes.
 *
 * `source.type: "internal"` is the loop-safety marker: it says this event
 * came from inside the platform, so anything reasoning about producer
 * behaviour can exclude it. The runner cannot itself prevent a job whose
 * output feeds its own input on the NEXT run — no framework can — but the
 * marker makes such a loop visible rather than indistinguishable from
 * customer traffic.
 */
function toEnvelope(mapped: ReverseEtlMapped, input: ReverseEtlRunInput): Record<string, unknown> {
  const at = input.now().toISOString();
  return {
    event_id: input.deriveId({
      job: input.job.key,
      version: input.job.version,
      customerId: mapped.customerId,
      properties: mapped.properties,
    }),
    event: mapped.event,
    schema_version: 1,
    // `occurred_at` is the RUN's clock, not a timestamp from the row. The
    // fact is "as of now, this customer's lifetime orders are N"; dating
    // it from the newest underlying order would claim the aggregate was
    // true then, which it was not — later orders had not happened yet.
    occurred_at: at,
    ingested_at: at,
    source: { id: `reverse-etl/${input.job.key}`, type: "internal" },
    identity: { customer_id: mapped.customerId },
    context: {},
    properties: { ...mapped.properties },
  };
}
