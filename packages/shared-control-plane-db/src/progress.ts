/**
 * Executor progress setters.
 *
 * These are the one category of write that legitimately carries no audit row,
 * and the distinction is worth being precise about: an audit record answers
 * "who decided this", and nobody decided these. They are a running job
 * reporting where it got to — chunk N of M replayed, the rebuild finished,
 * this token was used to authenticate. The operator decision that started the
 * job was already recorded by `startReplayExecutionWithAudit` or
 * `startClickhouseRebuildWithAudit`; recording every progress tick as well
 * would bury that one row under thousands.
 *
 * This module replaced `unaudited.ts`, which existed as a migration
 * affordance while CLI commands still hand-rolled their own transactions.
 * They no longer do — every operator mutation in the CLI and the admin UI now
 * goes through a `*WithAudit` function — so the escape hatch is gone, and
 * what remains is named for what it actually is.
 *
 * If you find yourself wanting to add an operator-initiated mutation here,
 * that is the signal it belongs in `mutations/` instead.
 */

export {
  markClickhouseRebuildJobCompleted,
  markClickhouseRebuildJobFailed,
  markClickhouseRebuildJobRunning,
} from "./queries/clickhouse-rebuild-jobs.js";
export { touchOperatorTokenLastUsedAt } from "./queries/operator-tokens.js";
export {
  type CompleteReplayJobInput,
  completeReplayJob,
  type FailReplayJobInput,
  failReplayJob,
  type RecordReplayChunkProgressInput,
  recordReplayChunkProgress,
} from "./queries/replay-jobs.js";
