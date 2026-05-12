# P1-003: ClickHouse DDL Skeleton

Status: Ready

## Goal

Create initial ClickHouse SQL files for Kafka Engine ingestion, append-only ingest log, deduped raw table, and a placeholder projection.

## Required Reading

- [ClickHouse](../../architecture/07-clickhouse.md)
- [Redpanda Topics](../../architecture/03-redpanda-topics.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)

## Dependencies

- None.

## Write Scope

Allowed:

```text
sql/clickhouse/
infra/clickhouse/
```

Forbidden:

```text
apps/
packages/
processors/
consumers/
```

## Implementation Notes

Use SQL files for:

```text
analytics Kafka Engine table
analytics_ingest_log
analytics_raw
materialized view from Kafka Engine to ingest log
materialized view or transform path to analytics_raw
```

The exact DDL can be skeletal but must reflect the two-layer storage model.

## Acceptance Criteria

- [ ] SQL files exist under `sql/clickhouse`.
- [ ] Kafka Engine table is not intended for direct querying.
- [ ] `analytics_ingest_log` is append-only.
- [ ] `analytics_raw` is deduped or prepared for dedupe by stable keys.

## Checks

Run where possible:

```text
docker compose config
```

## Handoff

```text
Files changed:
Commands run:
Checks passed:
Known gaps:
```

