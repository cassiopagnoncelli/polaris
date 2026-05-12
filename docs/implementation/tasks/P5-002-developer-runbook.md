# P5-002: Developer Runbook

Status: Ready

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

### ClickHouse query patterns reference

Include a "Querying ClickHouse" section in the runbook that covers, with concrete copy-paste examples:

- The role model: `polaris_service` for application code, `polaris_operator` for ad-hoc investigation.
- How to connect with each role from `clickhouse-client` and from the `shared-clickhouse` package.
- The `argMax(col, _version)` aggregation pattern for `analytics_raw` reads, accessed through `client.replay.argMaxByEventKey(...)`.
- `count(DISTINCT event_id)` for unique-count checks.
- Why plain `SELECT * FROM analytics_raw` returns merge-state duplicates, and why service code cannot do it (the role refuses).
- When to use the `operator.raw.query` escape hatch and what shows up in the metric/log trail when you do.

Link out to [07-clickhouse.md / Query Patterns](../../architecture/07-clickhouse.md) and [07-clickhouse.md / Access Control](../../architecture/07-clickhouse.md) for the full rules.

## Acceptance Criteria

- [ ] Developer runbook exists.
- [ ] Commands match implemented scripts.
- [ ] Troubleshooting section exists.
- [ ] Links to architecture docs exist.
- [ ] ClickHouse query patterns reference section exists with the four examples and the escape-hatch guidance.

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

