# P7-002: Replay Planner Dry Run

Status: Done

## Goal

Build replay planning and dry-run output before any replay execution exists.

## Required Reading

- [Processors and Replay](../../architecture/05-processors-and-replay.md)
- [Redpanda Topics](../../architecture/03-redpanda-topics.md)
- [Implementation Roadmap](../delivery-roadmap.md)

## Dependencies

- P7-001
- P0-007

## Write Scope

Allowed:

```text
packages/shared-replay/
apps/polaris-cli/
```

Forbidden:

```text
processors/*/v*/src/
consumers/*/v*/src/
```

## Implementation Notes

Dry-run output should estimate or report:

```text
source topic
project/environment scope
time or offset range
target processor/consumer/version
expected destination behavior
known risk flags
planned consumer group
```

If exact event counts are not available yet, output that explicitly rather than pretending.

## Acceptance Criteria

- [x] Planner produces deterministic dry-run output.
- [x] Planner refuses unscoped production replays.
- [x] Destination sends are shown as disabled by default.
- [x] CLI can render dry-run output as human text and JSON.
- [x] Tests cover replay scope validation.

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
  packages/shared-replay/                                            new package @polaris/shared-replay
    package.json
    tsconfig.json (extends ../../tsconfig.base.json)
    vitest.config.ts
    src/{index,types,planner,render}.ts
    test/planner.test.ts
  apps/polaris-cli/package.json                                      added @polaris/shared-replay workspace dep
  apps/polaris-cli/src/commands/replay/plan.ts                       new `polaris replay plan` runner + CommandDefinition (mutates:false)
  apps/polaris-cli/src/commands/replay/index.ts                      registered plan command, updated group docstring
  apps/polaris-cli/src/index.ts                                      re-exported replayPlanCommand + buildReplayPlanRunner
  apps/polaris-cli/test/replay-commands.test.ts                      pinned plan command id + mutates flag
  apps/polaris-cli/test/replay-plan-runner.test.ts                   new behavioral test for the plan runner (11 tests)
  pnpm-lock.yaml                                                     regenerated for the new workspace package

Commands run:
  pnpm install
  pnpm -r run build
  pnpm typecheck                       PASS
  pnpm lint                            PASS (4 pre-existing warnings only, none from new code)
  pnpm format                          PASS (re-applied formatter)
  pnpm format:check                    PASS
  pnpm test                            PASS (1639 passed + 1 skipped + 59 script tests)
  pnpm --filter @polaris/shared-replay test  PASS (54 planner tests)

Checks passed:
  - Pure-function planner under `@polaris/shared-replay`. No I/O: no Redpanda, no PostgreSQL,
    no process.env. The planner is callable from the CLI dry-run command today and the future
    executor (P7-003) tomorrow without changing its signature.
  - Deterministic plan output: `planReplay(decl, { now })` returns the same `ReplayPlan` shape
    every call. Tests pin a `now=2026-05-12T12:00:00Z` clock and snapshot the full plan record.
  - Closed-set rejection codes: missing project, invalid env/target/mode, inverted/future/stale
    windows, production replay without project_id, destination opt-in without note.
  - Destinations default disabled: `target=destinations` always lands on
    `destinations_enabled=false` unless the declaration explicitly opts in WITH a note
    (the planner refuses the declaration otherwise).
  - Risk flags: `wide_time_window`, `destination_sends_enabled`,
    `processor_target_not_pinned`, `single_event_replay`, `production_scope`. Emitted in
    closed-set declaration order so the human and JSON renderers stay deterministic.
  - Consumer-group naming: `polaris-replay.<project>.<env>.<target>.<replay_job_id>` —
    job-id suffix guarantees no two replays share a group.
  - Window chunking: 1-day chunks aligned to UTC midnight; first chunk starts at window_from,
    last chunk ends at window_to, no gaps, no overlaps. Zero-duration windows emit a single
    zero-width chunk so the executor still has something to iterate.
  - Human + JSON output paths: the CLI emits the full plan JSON under `--output json` and a
    line-oriented digest under `--output human` covering every section the task card listed
    (source topic, scope, time range, target processor/version, destination behavior, risks,
    planned consumer group, events_estimated=unknown since the planner is offline).
  - `polaris replay plan` registered with `mutates: false` so it bypasses the P6-007 production
    gate; defence-in-depth `rejectReplayPlanArguments` sweep runs before any store read.
  - `events_estimated` is explicit `null` ("unknown" in human renderer). The task card calls
    out: "If exact event counts are not available yet, output that explicitly rather than
    pretending." The planner does not consult Redpanda offsets in v1, so the field is null
    by design.

Known gaps:
  - `events_estimated` is always null in v1. Wiring in a Redpanda offset-based estimator is
    an incremental future task (would land alongside or after P7-003) and does not require
    changing the plan shape — only flipping the field from null to a number for the same
    declaration.
  - `processor_name` / `processor_version` and `destinations_enabled` / `destination_opt_in_note`
    are not persisted on `replay_jobs` (P7-001 deliberately keeps those out of the JOB row
    because they are planner-semantic). The CLI's `rowToDeclaration` therefore passes
    `undefined` for those fields; the planner emits `processor_target_not_pinned` risk for
    processor targets and defaults destinations to false. P7-003 / P7-004 will introduce
    typed control-plane surfaces for these fields without touching the planner contract.
```

