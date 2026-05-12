# P8-003: Sessionizer v1

Status: Ready

## Goal

Implement the first sessionizer processor using raw events and SDK session hints.

## Required Reading

- [Processors and Replay](../../architecture/05-processors-and-replay.md)
- [SDK Standards](../../architecture/10-sdk-standards.md)
- [Event Contract](../../architecture/01-event-contract.md)

## Dependencies

- P8-001
- P0-006

## Write Scope

Allowed:

```text
processors/sessionizer/v1/
catalog/events/session/
packages/shared-schemas/src/events/session/
```

Forbidden:

```text
packages/web-sdk/
packages/node-sdk/
apps/ingester-api/
consumers/
```

## Implementation Notes

- Web SDK sessions rotate after 30 minutes of inactivity.
- Processor may use SDK `session_id` as a hint, not as immutable truth.
- Campaign changes do not define session rotation in the SDK.
- Reinterpretation during replay must be possible.

## Acceptance Criteria

- [ ] Versioned processor exists with manifest and changelog.
- [ ] Processor emits governed session events or enriched session fields.
- [ ] 30-minute inactivity behavior is covered by fixtures.
- [ ] Campaign-change fixture does not force SDK-style session rotation.
- [ ] Output events include processor metadata.

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

