# P9-001: Destination Consumer Runtime

Status: Backlog

## Goal

Create shared destination consumer runtime helpers for batching, retries, delivery records, DLQs, rate limits, and replay suppression.

## Required Reading

- [Destinations](../../architecture/06-destinations.md)
- [Processors and Replay](../../architecture/05-processors-and-replay.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)

## Dependencies

- P0-007
- P1-002
- P6-004

## Write Scope

Allowed:

```text
packages/shared-destinations/
consumers/
db/
migrations/
```

Forbidden:

```text
apps/ingester-api/
packages/web-sdk/
packages/node-sdk/
processors/
```

## Implementation Notes

- Keep the runtime thin.
- Mapping semantics remain in consumer code.
- PostgreSQL stores destination instance state and delivery records.
- Destination sends during replay are disabled by default.
- Secrets must never appear in logs, DLQs, or delivery records.

## Acceptance Criteria

- [ ] Shared destination package exists.
- [ ] Delivery record helper exists.
- [ ] Retry/DLQ helper exists.
- [ ] Replay suppression helper exists.
- [ ] Tests cover idempotent delivery key generation and secret redaction.

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

