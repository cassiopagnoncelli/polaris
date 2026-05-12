# P1-003: ClickHouse DDL Skeleton

Status: Done

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
  sql/clickhouse/README.md                                       (new)
  sql/clickhouse/00_database.sql                                 (new)
  sql/clickhouse/10_analytics_events_queue.sql                   (new)  Kafka Engine table on analytics.events, JSONEachRow
  sql/clickhouse/20_analytics_ingest_log.sql                     (new)  {replicated}MergeTree append-only
  sql/clickhouse/21_mv_queue_to_ingest_log.sql                   (new)  MV: queue -> ingest log (preserves transport truth)
  sql/clickhouse/30_analytics_raw.sql                            (new)  {replicated}ReplacingMergeTree(_version) deduped facts
  sql/clickhouse/31_mv_queue_to_raw.sql                          (new)  MV: queue -> raw, flattens nested JSON
  sql/clickhouse/projections/40_event_daily_counts.sql           (new)  {replicated}SummingMergeTree projection (engine rationale in comment)
  sql/clickhouse/materialized-views/41_mv_raw_to_event_daily_counts.sql (new)  argMax(occurred_at, _version) MV
  sql/clickhouse/roles/00_roles.sql                              (new)  CREATE ROLE polaris_service, polaris_operator
  sql/clickhouse/roles/01_grants.sql                             (new)  service SELECT on ingest log + projections only; defensive REVOKEs on analytics_raw and queue; operator gets polaris.* + DDL
  sql/clickhouse/roles/README.md                                 (new)  role model + helper-package mapping
  infra/clickhouse/README.md                                     (new)
  infra/clickhouse/config.d/macros-local.xml                     (new)  {replicated} = '', no Keeper
  infra/clickhouse/config.d/macros-production.xml                (new)  {replicated} = 'Replicated' + default_replica_path/name
  infra/clickhouse/config.d/keeper.xml                           (new)  embedded Keeper for production v1
  infra/clickhouse/compose/docker-compose.production.yml         (new)  production-mode compose showing ClickHouse + embedded Keeper
  docs/implementation/tasks/P1-003-clickhouse-ddl-skeleton.md    (this handoff)

Commands run:
  docker compose -f infra/clickhouse/compose/docker-compose.production.yml config
    FAIL (without env) -> intended: CLICKHOUSE_ADMIN_PASSWORD is `:?` required
    PASS (with CLICKHOUSE_ADMIN_PASSWORD=dummy CLICKHOUSE_ADMIN_USER=polaris_admin set)
  xmllint --noout on all three XML config files -> PASS
  grep scan for `FINAL` keyword across sql/ and infra/ -> only present in comments documenting that it is forbidden
  grep scan for `analytics_events_queue` references -> only the CREATE TABLE, the two sanctioned MVs, the REVOKE grants, and docs

Checks passed:
  docker compose config (production snippet) validates with required env vars set
  XML config files are well-formed
  No FINAL keyword used in any DDL or MV
  No SELECT from the Kafka Engine table outside the two sanctioned MVs
  polaris_service grants do NOT include analytics_raw or analytics_events_queue (and have defensive REVOKEs)
  polaris_operator has the broader grants required for replay/rebuild but does NOT have SELECT on the Kafka Engine table either
  At least one projection table (event_daily_counts) is present, fed by an argMax-based MV
  {replicated} macro is used in every Polaris-owned MergeTree-family engine line

Known gaps:
  Docker daemon was not running in this worktree; could not boot a ClickHouse container to syntactically parse the DDL end-to-end against real ClickHouse. Syntactic validation was limited to docker compose config and xmllint.
  Root docker-compose.yml does not exist yet (owned by P1-001). Wiring the local/dev ClickHouse service to mount macros-local.xml is described in infra/clickhouse/README.md but must be implemented when P1-001 lands.
  Migration runner / apply tooling is intentionally not in scope (P4-002 owns it). SQL files are ordered lexically to make any runner that iterates the directory produce a valid apply order.
  Production user/password provisioning is left to P11-004 (secret provider). 00_roles.sql defines the roles only; binding role -> user happens at deploy time.
  Only one example projection (event_daily_counts) is shipped, as required for "at least one". Real projections land with their owning feature tasks.
```

