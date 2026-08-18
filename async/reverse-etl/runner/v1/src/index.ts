/**
 * reverse-etl runner v1 — warehouse rows back through the ingester.
 *
 * A run, not a daemon: `polaris reverse-etl run <job>` on a cron. The
 * runner is the mapping and batching; the CLI supplies the query reader,
 * the HTTP client and the run record.
 */

export {
  type IngestBatchResult,
  type ReverseEtlIngestClient,
  type ReverseEtlQueryRunner,
  type ReverseEtlRunInput,
  type ReverseEtlRunResult,
  runReverseEtl,
} from "./runner.js";
