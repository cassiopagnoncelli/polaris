# P9-007: Destination Delivery Records and DLQ Triage

Status: Ready

## Goal

Make destination delivery records and DLQs inspectable and operationally useful.

## Required Reading

- [Destinations](../../architecture/06-destinations.md)
- [Observability and Operations](../../architecture/08-observability-and-operations.md)
- [Control Plane](../../architecture/02-control-plane.md)

## Dependencies

- P9-001
- P6-001

## Write Scope

Allowed:

```text
apps/polaris-cli/
packages/shared-destinations/
docs/operations/
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

CLI commands should cover:

```text
polaris deliveries list
polaris deliveries show <delivery_id>
polaris dlq list
polaris dlq show <id>
polaris dlq retry <id>
polaris dlq mark-resolved <id>
```

Retry commands must respect idempotency and replay policy.

## Acceptance Criteria

- [ ] Delivery inspection commands exist.
- [ ] DLQ inspection commands exist.
- [ ] Retry/resolve actions are audited.
- [ ] Secrets are absent from delivery/DLQ output.
- [ ] Runbook explains triage workflow.

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

