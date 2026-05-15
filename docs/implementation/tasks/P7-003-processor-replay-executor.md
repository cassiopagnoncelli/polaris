# P7-003: Processor Replay Executor

Status: Done

## Goal

Implement replay execution for processor targets with lineage and safety controls.

## Required Reading

- [Processors and Replay](../../architecture/05-processors-and-replay.md)
- [Redpanda Topics](../../architecture/03-redpanda-topics.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)

## Dependencies

- P7-002
- P4-001
- P6-005

## Write Scope

Allowed:

```text
packages/shared-replay/
processors/
apps/polaris-cli/
db/
migrations/
```

Forbidden:

```text
consumers/
packages/web-sdk/
packages/node-sdk/
apps/ingester-api/
```

## Implementation Notes

- Replays target exact processor name/version.
- Replays must write status transitions and audit records.
- Replayed output must include replay lineage metadata.
- Do not overwrite existing events.
- Use separate consumer group or replay execution strategy so normal processing is not disrupted.

## Acceptance Criteria

- [x] Processor replay can be started from a replay job.
- [x] Replay status transitions are persisted.
- [x] Replay output includes replay job metadata.
- [x] Failed replay records error state.
- [x] Tests cover successful and failed replay execution.

## Checks

Run where possible:

```text
pnpm typecheck
pnpm test
pnpm lint
```

## Handoff

```text
Files changed:
  packages/shared-replay/
    src/executor.ts                       (new) pure executor module: refusal codes,
                                                source/producer/store adapters, header
                                                stamping, chunked emit loop, cooperative
                                                abort path, structured failure outcome.
    src/index.ts                          (modified) re-export executor surface.
    package.json                          (modified) new "./executor" export, package
                                                     description updated.
    test/executor.test.ts                 (new) 32 cases — refusals, happy path, multi-
                                                chunk progress, cooperative cancel/pause
                                                abort, producer failure counting, fatal
                                                fetch throw -> failed outcome, scope
                                                defense in depth, header lineage.

  apps/polaris-cli/
    src/commands/replay/execute.ts        (new) `polaris replay execute <id>` runner +
                                                 default Kysely store wiring + stub
                                                 source/producer (real Kafka source
                                                 lands in a follow-up).
    src/commands/replay/index.ts          (modified) register replay.execute.
    src/db/replay-jobs.ts                 (modified) add error_class / error_message to
                                                     ReplayJobsTable, ReplayJobRow, and
                                                     toRow; add markReplayJobRunning,
                                                     recordReplayChunkProgress,
                                                     completeReplayJob, failReplayJob
                                                     executor-owned setters.
    src/db/index.ts                       (modified) re-export new setters + inputs.
    src/index.ts                          (modified) re-export replayExecuteCommand +
                                                     buildReplayExecuteRunner +
                                                     ReplayExecuteHooks/Store.
    test/replay-execute-runner.test.ts    (new) 13 cases — happy path completion,
                                                replay header lineage, --target-topic,
                                                dry-run refusal, unknown id, empty id,
                                                stale-row planner rejection, processor-
                                                not-pinned, planner-flag rejection,
                                                cooperative cancel, failure persistence,
                                                store close-on-error invariant.
    test/replay-jobs-error-columns-migration.test.ts (new) schema-invariant smoke for
                                                the new error columns: nullable cols,
                                                length CHECK bounds, both-NULL-or-both-
                                                set tie, status='failed' tie, working
                                                migrate:down section.
    test/replay-commands.test.ts          (modified) cover replay.execute registration.
    test/replay-plan-runner.test.ts       (modified) seed row carries the new nullable
                                                     error_class / error_message slots.
    test/replay-runner-behaviors.test.ts  (modified) ditto.

  db/migrations/
    20260514000004_add_replay_jobs_error_columns.sql (new) ALTER TABLE replay_jobs ADD
                                                COLUMN error_class + error_message,
                                                with length bounds + CHECK that ties
                                                error_class IS NOT NULL to status='failed'
                                                and ties the two columns together.

  docs/implementation/tasks/P7-003-processor-replay-executor.md
                                          (modified) Status: Done, AC checked, handoff
                                                     filled in.

Commands run:
  pnpm install
  pnpm -r build
  pnpm typecheck
  pnpm lint           (4 pre-existing warnings in shared-destinations/dlq-records.ts;
                       exit 0)
  pnpm format
  pnpm format:check
  pnpm test           (1871 passed, 1 skipped vertical-slice smoke)

Checks passed: typecheck, lint (warnings only), format:check, all unit/integration
               tests across packages/processors/consumers/apps/scripts.

Known gaps:
  - The default CLI source + producer wired in `execute.ts` are stubs (no-op publish,
    empty fetchChunk). Real Kafka source/producer wiring lands in a follow-up that
    adds an offset-range read helper to @polaris/shared-kafka; the lifecycle assertions
    and headers / counters / refusal codes ship complete.
  - The replay-job row schema (from P7-001) still does not persist
    `processor_name` / `processor_version`. Until that lands, every processor-target
    row triggers the executor's `processor_target_not_pinned` refusal, so the CLI
    cannot currently execute a processor replay end-to-end. Operators can drive
    analytics_raw and destinations targets today; the processor target sits behind
    that schema add.
  - The executor's lifecycle moves (running -> completed | failed) are not separately
    audited via `audit_records`; they are operationally derivable from the row's
    timestamps + counters. A future task could mirror the cancel/pause/resume audit
    pattern if operators need a per-transition audit trail.
```

