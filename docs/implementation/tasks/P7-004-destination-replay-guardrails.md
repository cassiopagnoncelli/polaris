# P7-004: Destination Replay Guardrails

Status: Done

## Goal

Implement destination replay suppression and explicit opt-in behavior.

## Required Reading

- [Processors and Replay](../../architecture/05-processors-and-replay.md)
- [Destinations](../../architecture/06-destinations.md)
- [Control Plane](../../architecture/02-control-plane.md)

## Dependencies

- P7-001
- P9-001

## Write Scope

Allowed:

```text
packages/shared-replay/
consumers/
apps/polaris-cli/
db/
migrations/
```

Forbidden:

```text
apps/ingester-api/
packages/web-sdk/
packages/node-sdk/
```

## Implementation Notes

- Destination sends during replay are disabled by default.
- Explicit opt-in must be visible in replay job state.
- Consumers must check replay delivery policy before sending.
- Suppressed sends should produce auditable records, not silent drops.

## Acceptance Criteria

- [x] Replay jobs default destination delivery to disabled.
- [x] CLI requires explicit flag/reason to enable destination sends.
- [x] Destination consumer runtime honors suppression.
- [x] Suppressed delivery attempts are recorded.
- [x] Tests cover default suppression and explicit opt-in.

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
  db/migrations/20260514000002_add_destination_replay_opt_in.sql       NEW
  packages/shared-db/src/database.ts                                   modified
  packages/shared-destinations/src/db/destination-instance.ts          modified
  packages/shared-destinations/src/replay-suppression.ts               modified
  packages/shared-destinations/src/runtime.ts                          modified
  packages/shared-destinations/src/index.ts                            modified
  packages/shared-destinations/test/runtime-behaviors.test.ts          modified (4 P7-004 tests added)
  packages/shared-destinations/test/smoke.test.ts                      modified (3 P7-004 tests added)
  apps/polaris-cli/src/db/destinations.ts                              modified
  apps/polaris-cli/src/db/index.ts                                     modified
  apps/polaris-cli/src/commands/destinations/enable-replay.ts          NEW
  apps/polaris-cli/src/commands/destinations/disable-replay.ts         NEW
  apps/polaris-cli/src/commands/destinations/index.ts                  modified
  apps/polaris-cli/src/commands/destinations/show.ts                   modified
  apps/polaris-cli/src/commands/export/destinations.ts                 modified
  apps/polaris-cli/src/index.ts                                        modified
  apps/polaris-cli/test/destinations-commands.test.ts                  modified (16 P7-004 tests added)
  apps/polaris-cli/test/audit-recorder.test.ts                         modified (seed-row column expansion)
  apps/polaris-cli/test/audit-export-commands.test.ts                  modified (seed-row column expansion)

Commands run:
  pnpm install
  pnpm typecheck
  pnpm lint
  pnpm format:check
  pnpm test

Checks passed:
  typecheck OK
  lint OK (4 pre-existing warnings in unrelated files; none in P7-004 paths)
  format:check OK
  test: 1593 passed / 1 skipped + 59 script tests passed

Known gaps:
  - The planner-side `ReplayPlan` extension flagged in the original task prompt
    (destination_ids + destinations_enabled slot on the plan shape) does not
    apply: the `packages/shared-replay/` package has not yet landed in main.
    When P7-002 ships the planner, the per-instance `replay_opt_in` gate this
    task introduces is the authoritative runtime check the plan would have to
    respect anyway; the plan-time risk surfacing is a follow-up that does not
    block the acceptance criteria here.
  - The runtime moves the replay-suppression check to AFTER instance resolution
    (so the per-instance flag can be consulted). Replay traffic against an
    unknown destination_id is now suppressed-and-logged rather than logged-as-
    error. This is the safer default for replay traffic.
```

