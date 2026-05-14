# P7-001: Replay Job Model and CLI

Status: Done (merged in `f670d28`; behavioral test matrix is a follow-up)

## Goal

Implement the durable replay job model and basic CLI commands for creating and inspecting replay jobs.

## Required Reading

- [Processors and Replay](../../architecture/05-processors-and-replay.md)
- [Control Plane](../../architecture/02-control-plane.md)
- [Redpanda Topics](../../architecture/03-redpanda-topics.md)

## Dependencies

- P6-001
- P1-002

## Write Scope

Allowed:

```text
apps/polaris-cli/
db/
migrations/
packages/shared-replay/
```

Forbidden:

```text
apps/ingester-api/
processors/*/v*/src/
consumers/*/v*/src/
```

## Implementation Notes

Replay jobs must include:

```text
project_id
environment
source_topic
time window or offset range
target processor/consumer
target version
destination behavior
reason
requested_by
status
timestamps
outcome
```

Commands should start with:

```text
polaris replays create --dry-run ...
polaris replays list
polaris replays show <replay_job_id>
```

## Acceptance Criteria

- [ ] Replay job tables exist.
- [ ] CLI can create dry-run replay job records.
- [ ] CLI can list/show replay jobs.
- [ ] Replay jobs record requester and reason.
- [ ] Tests cover valid and invalid replay scopes.

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
Commands run:
Checks passed:
Known gaps:
```

