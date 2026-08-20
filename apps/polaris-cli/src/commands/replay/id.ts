/**
 * `replay_job_id` generator and constants for the `polaris replay`
 * command group.
 *
 * The id shape mirrors the other Polaris-issued public id prefixes so
 * platform-issued ids stay greppable and self-describing:
 *
 *   - `polaris_ak_<uuidv7>`  API key id (P6-003)
 *   - `polaris_dst_<uuidv7>` destination instance id (P6-004)
 *   - `polaris_ot_<uuidv7>`  operator token id (P6-007)
 *   - `polaris_rpj_<uuidv7>` replay job id (P7-001, this file)
 *
 * Mirrors the `replay_jobs_replay_job_id_format` CHECK constraint in
 * `db/postgres/migrations/20260512000011_create_replay_jobs.sql`.
 */
import { v7 as uuidv7 } from "uuid";

/** Prefix marker on `replay_job_id`. */
export const REPLAY_JOB_ID_PREFIX = "polaris_rpj_";

/**
 * Generate a fresh `polaris_rpj_<uuidv7>` id. UUIDv7 keeps the lexical
 * ordering aligned with creation time, so the migration's
 * `(status, created_at DESC)` index supports time-ordered scans without
 * an explicit `created_at` index probe.
 */
export function generateReplayJobId(): string {
  return `${REPLAY_JOB_ID_PREFIX}${uuidv7()}`;
}
