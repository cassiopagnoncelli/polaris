# P11-005: Backup and Retention Runbooks

Status: Backlog

## Goal

Define and document backup, restore, and retention policies for production operation.

## Required Reading

- [Redpanda Topics](../../architecture/03-redpanda-topics.md)
- [ClickHouse](../../architecture/07-clickhouse.md)
- [Control Plane](../../architecture/02-control-plane.md)

## Dependencies

- P1-001
- P1-002
- P4-002

## Write Scope

Allowed:

```text
docs/operations/
docs/deployment/
infra/
```

Forbidden:

```text
application code unless adding non-invasive scripts explicitly called by docs
```

## Implementation Notes

Cover:

- PostgreSQL backup and restore
- ClickHouse backup and restore
- Redpanda 90-day raw retention
- future raw object-storage archive
- Redis non-canonical/ephemeral expectations
- DLQ retention policy
- audit retention policy

## Acceptance Criteria

- [ ] Backup/restore runbook exists.
- [ ] Retention defaults are documented.
- [ ] Redis non-durable role is explicit.
- [ ] Object-storage archive is marked future if not implemented.
- [ ] Restore validation steps are included.

## Checks

Run where possible:

```text
rg -n "backup|restore|retention|archive|Redis" docs/operations docs/deployment
```

## Handoff

```text
Files changed:
Commands run:
Checks passed:
Known gaps:
```

