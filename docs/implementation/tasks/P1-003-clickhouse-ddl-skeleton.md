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
roles and grants
```

The exact DDL can be skeletal but must reflect the two-layer storage model.

### Roles and grants

Create `sql/clickhouse/roles/` with:

- `00_roles.sql` — defines `polaris_service` and `polaris_operator` roles
- `01_grants.sql` — grants:
  - `polaris_service`: `SELECT` on `analytics_ingest_log`, all projection tables, and the `analytics` schema views; no access to `analytics_raw` or Kafka Engine tables
  - `polaris_operator`: `SELECT` on all `analytics.*` tables; additional DDL grants as the schema grows
- A README in `sql/clickhouse/roles/` documenting the role model and pointing to [Access Control](../../architecture/07-clickhouse.md)

Both roles exist in both local/dev and production. Local/dev applies them through the same compose-driven init flow as the rest of the DDL; production applies them through the standard migration path.

Services and the CLI route through `packages/shared-clickhouse/` (P0-010) and authenticate via these roles. Direct `@clickhouse/client` imports outside the helper package are blocked.

### Engine families and macros

Parameterize DDL through a `{replicated}` macro so the same SQL file works in both modes:

```text
local/dev      {replicated} expands to ''           plain MergeTree, ReplacingMergeTree
production     {replicated} expands to 'Replicated' ReplicatedMergeTree, ReplicatedReplacingMergeTree
```

DDL should look like:

```sql
CREATE TABLE analytics_raw ON CLUSTER '{cluster}' (...)
ENGINE = {replicated}ReplacingMergeTree(<args>)
...
```

Production also requires:

- `{cluster}` macro defined in ClickHouse server config
- `{shard}` and `{replica}` macros
- ClickHouse Keeper alongside ClickHouse (embedded is acceptable for the first single-replica deployment)

Local/dev does not run Keeper; the macros expand to empty values so plain engines work.

### Query patterns

- `analytics_raw` is never queried without explicit dedupe. The MV that emits to projection tables must use `argMax(col, _version)` aggregation, not `FINAL`.
- Include at least one skeletal projection table fed by an `argMax`-based MV to demonstrate the pattern.

## Acceptance Criteria

- [ ] SQL files exist under `sql/clickhouse`.
- [ ] Kafka Engine table is not intended for direct querying.
- [ ] `analytics_ingest_log` is append-only.
- [ ] `analytics_raw` is deduped or prepared for dedupe by stable keys.
- [ ] DDL uses `{replicated}` macro so the same file works in local/dev and production.
- [ ] At least one projection table exists with an MV that uses `argMax(_version)` (not `FINAL`).
- [ ] Production compose config shows ClickHouse Keeper running alongside ClickHouse.
- [ ] Local/dev compose config does not require Keeper.
- [ ] `sql/clickhouse/roles/` exists with `polaris_service` and `polaris_operator` definitions and grants.
- [ ] `polaris_service` grants explicitly exclude `analytics_raw` and Kafka Engine tables.
- [ ] Roles README documents the role model and links to the architecture doc.

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

