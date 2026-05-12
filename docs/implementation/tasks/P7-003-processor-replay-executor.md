# P7-003: Processor Replay Executor

Status: Backlog

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

- [ ] Processor replay can be started from a replay job.
- [ ] Replay status transitions are persisted.
- [ ] Replay output includes replay job metadata.
- [ ] Failed replay records error state.
- [ ] Tests cover successful and failed replay execution.

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

