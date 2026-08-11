# Polaris ClickHouse Roles

Two roles ship in v1. They are the database-level enforcement of the
ClickHouse query patterns described in
[`docs/architecture/07-clickhouse.md`](../../../docs/architecture/07-clickhouse.md)
("Access Control"). Lint-over-SQL was considered and rejected — the
database itself refuses unauthorized reads, so there is no
"I forgot the comment" failure mode.

| Role | Reads | Writes / DDL | Used by |
| --- | --- | --- | --- |
| `polaris_service` | `analytics_ingest_log`, every projection table | none | ingester, processors, destination consumers, future dashboard API, CLI routine inspection |
| `polaris_operator` | `polaris.*` (incl. `analytics_raw`), select system tables | `CREATE`, `ALTER`, `DROP`, `INSERT`, `TRUNCATE`, `OPTIMIZE` on `polaris.*` | replay/rebuild jobs, operator investigation, CLI operator commands |

Neither role has direct `SELECT` on the ingestion interface table
(`polaris.analytics_events_queue`). The materialized-view pipeline
is the only sanctioned reader; the architecture forbids application
or operator code from querying the queue directly.

## Files

- [`00_roles.sql`](./00_roles.sql) — role definitions. Applied once
  per ClickHouse instance / cluster bootstrap.
- [`01_grants.sql`](./01_grants.sql) — grants. Re-run whenever a new
  projection table lands so `polaris_service` can read it.

## Application order

These files apply after the schema DDL has run, because the grants
reference concrete tables. The compose-driven local/dev init flow
applies them in lexical order alongside the rest of
`sql/clickhouse/`. Production applies them through the standard
migration runner, which inherits the same lexical ordering.

```text
00_database.sql
10_analytics_events_queue.sql
20_analytics_ingest_log.sql
21_mv_queue_to_ingest_log.sql
30_analytics_raw.sql
31_mv_queue_to_raw.sql
projections/40_event_daily_counts.sql
materialized-views/41_mv_raw_to_event_daily_counts.sql
roles/00_roles.sql
roles/01_grants.sql
```

## How services and the CLI authenticate

Services and CLI code MUST go through
[`packages/shared-clickhouse/`](../../../docs/implementation/tasks/P0-010-shared-clickhouse-client.md).
A workspace-level import rule blocks direct
`@clickhouse/client` imports outside that package, so the role
binding is enforced both by the database (grants below) and by the
codebase (helper-package monopoly on the official client).

The helper exposes two profiles:

- `service` — authenticates as `polaris_service`. Exposes
  projection-table reads, `ingestLog.inspect`, and `health.check`.
  Does not expose any method that can return rows from
  `analytics_raw`.
- `operator` — authenticates as `polaris_operator`. Adds
  `replay.argMaxByEventKey`, `replay.countDistinctEvents`, and the
  `operator.raw.query` escape hatch. The escape hatch emits a metric
  and a structured log line on every call.

User identities and credential references for both roles are
provisioned through the secret provider
([`P11-004`](../../../docs/implementation/tasks/P11-004-production-secret-provider.md)).
This DDL only defines and grants the roles themselves.

## Adding a new projection

1. Write the projection table SQL under
   [`sql/clickhouse/projections/`](../projections/) using
   `{replicated}<Engine>` for engine selection.
2. Write the argMax-based MV under
   [`sql/clickhouse/materialized-views/`](../materialized-views/).
3. Add a `GRANT ... SELECT ON polaris.<new_projection> TO polaris_service`
   line to [`01_grants.sql`](./01_grants.sql).
4. Add a typed read method for the projection to
   `packages/shared-clickhouse/src/projections/`.

`polaris_operator` does not need a grant update because it holds
`SELECT ON polaris.*`.

## What is intentionally NOT granted

- `polaris.analytics_events_queue` — neither role gets `SELECT`. The
  MV pipeline is the only authorized reader. Querying the ingestion interface
  Engine table directly would consume offsets and starve the MVs.
- `polaris.analytics_raw` for `polaris_service` — the helper's
  `replay` namespace runs `argMax`-based reads against
  `analytics_raw` and requires the operator profile. Service code
  reads pre-deduped projection tables, not raw facts.
- `FINAL` is not used in any MV or helper-package method. Operators
  who genuinely need it append `SETTINGS final = 1` per query.

See also: [Engineering Standards / ClickHouse Access](../../../docs/architecture/09-engineering-standards.md#clickhouse-access).
