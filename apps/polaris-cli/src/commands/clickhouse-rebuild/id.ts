/**
 * `clickhouse_rebuild_job_id` generator and constants for the
 * `polaris clickhouse-rebuild` command group.
 *
 * The id shape mirrors the other Polaris-issued public id prefixes:
 *
 *   - `polaris_ak_<uuidv7>`  API key id (P6-003)
 *   - `polaris_dst_<uuidv7>` destination instance id (P6-004)
 *   - `polaris_ot_<uuidv7>`  operator token id (P6-007)
 *   - `polaris_rpj_<uuidv7>` replay job id (P7-001)
 *   - `polaris_chr_<uuidv7>` ClickHouse rebuild job id (P7-005, this file)
 *
 * Mirrors the `clickhouse_rebuild_jobs_id_format` CHECK constraint in
 * `db/migrations/20260515000001_create_clickhouse_rebuild_jobs.sql`.
 */
import { v7 as uuidv7 } from "uuid";

export const CLICKHOUSE_REBUILD_JOB_ID_PREFIX = "polaris_chr_";

/**
 * Generate a fresh `polaris_chr_<uuidv7>` id. UUIDv7 keeps the
 * lexical ordering aligned with creation time, so the migration's
 * `(status, created_at DESC)` index supports time-ordered scans
 * without an explicit `created_at` index probe.
 */
export function generateClickhouseRebuildJobId(): string {
  return `${CLICKHOUSE_REBUILD_JOB_ID_PREFIX}${uuidv7()}`;
}
