# P4-002: ClickHouse Ingestion Integration

Status: Backlog

## Goal

Wire the ClickHouse DDL and local stack so `analytics.events` can be persisted into `analytics_ingest_log` and represented in `analytics_raw`.

## Required Reading

- [ClickHouse](../../architecture/07-clickhouse.md)
- [Redpanda Topics](../../architecture/03-redpanda-topics.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)

## Dependencies

- P1-001
- P1-003
- P4-001

## Write Scope

Allowed:

```text
sql/clickhouse/
infra/clickhouse/
scripts/
package.json
```

Forbidden:

```text
apps/
packages/web-sdk/
packages/node-sdk/
processors/
consumers/
```

## Implementation Notes

- Do not query Kafka Engine tables directly.
- Provide a repeatable local way to apply ClickHouse SQL.
- Add a basic query script if useful.

## Acceptance Criteria

- [ ] ClickHouse SQL can be applied locally.
- [ ] Kafka Engine table points at `analytics.events`.
- [ ] `analytics_ingest_log` exists.
- [ ] `analytics_raw` exists.
- [ ] A basic query path is documented or scripted.

## Checks

Run where possible:

```text
docker compose up -d
```

## Handoff

```text
Files changed:
Commands run:
Checks passed:
Known gaps:
```

