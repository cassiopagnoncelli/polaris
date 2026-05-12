# P7-005: ClickHouse Rebuild Workflows

Status: Backlog

## Goal

Implement controlled ClickHouse rebuild workflow scaffolding for analytical projections.

## Required Reading

- [ClickHouse](../../architecture/07-clickhouse.md)
- [Processors and Replay](../../architecture/05-processors-and-replay.md)
- [Control Plane](../../architecture/02-control-plane.md)

## Dependencies

- P4-002
- P7-001

## Write Scope

Allowed:

```text
apps/polaris-cli/
packages/shared-clickhouse/
sql/clickhouse/
db/
migrations/
docs/development/
```

Forbidden:

```text
apps/ingester-api/
packages/web-sdk/
packages/node-sdk/
```

## Implementation Notes

- ClickHouse projection rebuilds are replay/rebuild workflows, not manual one-off SQL.
- Do not query Kafka Engine tables directly.
- Rebuild jobs should record source range, target tables, reason, requester, and outcome.
- This task may implement scaffolding and dry-run before destructive rebuild behavior.

## Acceptance Criteria

- [ ] CLI can create ClickHouse rebuild dry-run records.
- [ ] Rebuild target tables are validated.
- [ ] Rebuild actions are auditable.
- [ ] Docs warn against manual patching as normal fix path.
- [ ] Tests cover rebuild planning validation.

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

