# P5-002: Developer Runbook

Status: Backlog

## Goal

Document how a developer runs the local vertical slice and troubleshoots common failures.

## Required Reading

- [Project README](../../README.md)
- [Observability and Operations](../../architecture/08-observability-and-operations.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)

## Dependencies

- P5-001

## Write Scope

Allowed:

```text
docs/development/
docs/implementation/
README.md
```

Forbidden:

```text
apps/
packages/
processors/
consumers/
sql/
infra/
```

## Implementation Notes

Document:

- install
- local services
- migrations
- starting ingester
- sending a test event
- starting processor
- checking ClickHouse
- common failures
- reset/cleanup commands

Do not invent commands that do not exist.

## Acceptance Criteria

- [ ] Developer runbook exists.
- [ ] Commands match implemented scripts.
- [ ] Troubleshooting section exists.
- [ ] Links to architecture docs exist.

## Checks

Run where possible:

```text
rg -n "TODO|TBD" docs/development docs/implementation README.md
```

## Handoff

```text
Files changed:
Commands run:
Checks passed:
Known gaps:
```

