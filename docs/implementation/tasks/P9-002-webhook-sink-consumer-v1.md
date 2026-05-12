# P9-002: Webhook Sink Consumer v1

Status: Backlog

## Goal

Implement a simple webhook destination consumer for internal testing and destination runtime validation.

## Required Reading

- [Destinations](../../architecture/06-destinations.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)
- [Control Plane](../../architecture/02-control-plane.md)

## Dependencies

- P9-001
- P6-004

## Write Scope

Allowed:

```text
consumers/webhook-sink/v1/
catalog/events/
packages/shared-destinations/
```

Forbidden:

```text
apps/ingester-api/
packages/web-sdk/
packages/node-sdk/
processors/
```

## Implementation Notes

- Use this as the first real destination consumer because it can be tested without vendor credentials.
- Mapping remains code-only.
- Support delivery records, retries, and DLQs.
- Use a mock destination endpoint in tests where practical.

## Acceptance Criteria

- [ ] Versioned consumer exists with manifest/changelog.
- [ ] Consumer reads canonical events from configured topic.
- [ ] Consumer sends HTTP webhook payloads.
- [ ] Delivery records are written.
- [ ] Retry and DLQ behavior are tested.

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

