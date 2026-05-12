# Polaris ClickHouse Infra

Configuration files that ride alongside the SQL DDL in
[`sql/clickhouse/`](../../sql/clickhouse/) to make a single set of
SQL files work in both local/dev and production.

See [`docs/architecture/07-clickhouse.md`](../../docs/architecture/07-clickhouse.md)
for the architecture rationale.

## Layout

```text
infra/clickhouse/
  config.d/
    macros-local.xml          local/dev macros: {replicated} = ''
    macros-production.xml     production macros: {replicated} = 'Replicated'
    keeper.xml                embedded ClickHouse Keeper config (production only)
  compose/
    docker-compose.production.yml   production-mode compose snippet (ClickHouse + embedded Keeper)
  README.md                   this file
```

## Macros

ClickHouse macros parameterize the same DDL across environments.
The Polaris SQL files reference three macros:

| Macro | Local/dev | Production |
| --- | --- | --- |
| `{cluster}` | empty | `polaris` |
| `{replicated}` | empty | `Replicated` |
| `{shard}` | `01` | `01` (v1) |
| `{replica}` | `local` | per-host (e.g. `replica01`) |

`{replicated}` is the load-bearing macro for engine selection. With
it empty, `{replicated}ReplacingMergeTree(_version)` parses as
`ReplacingMergeTree(_version)`. Set to `Replicated`, the same line
parses as `ReplicatedReplacingMergeTree(_version)`.

Production additionally sets two server-level defaults so the
engine spec never has to repeat the ZooKeeper path:

```xml
<default_replica_path>/clickhouse/tables/{shard}/{database}/{table}</default_replica_path>
<default_replica_name>{replica}</default_replica_name>
```

This means SQL files can use the short form
`{replicated}ReplacingMergeTree(_version)` instead of carrying an
explicit `'/clickhouse/...'` path argument. Local/dev does not need
the defaults — plain `MergeTree` ignores them.

## ClickHouse Keeper

Production runs ClickHouse Keeper from day one. The v1 deployment
runs an embedded Keeper inside the same ClickHouse process
(`keeper.xml`). When a second replica lands, Keeper graduates to
its own service or a dedicated quorum, and the embedded
`<keeper_server>` stanza is removed.

Local/dev does not run Keeper. Plain `MergeTree` engines do not
register anywhere, so there is nothing to coordinate.

## Compose snippets

[`compose/docker-compose.production.yml`](./compose/docker-compose.production.yml)
is a production-mode compose file for staging environments and for
smoke-testing the Replicated\* DDL paths. It is not the local/dev
stack — that lives in the root `docker-compose.yml` owned by
[P1-001](../../docs/implementation/tasks/P1-001-local-core-compose.md),
which mounts `macros-local.xml` and skips `keeper.xml`.

Validate the production compose snippet with:

```bash
docker compose -f infra/clickhouse/compose/docker-compose.production.yml config
```

## How to wire macros in the local/dev root compose

When `docker-compose.yml` lands (P1-001), the ClickHouse service
should mount the local macros:

```yaml
clickhouse:
  image: clickhouse/clickhouse-server:24.8
  volumes:
    - ./infra/clickhouse/config.d/macros-local.xml:/etc/clickhouse-server/config.d/macros.xml:ro
  # NOTE: do not mount keeper.xml in local/dev.
```

That mount is the entire engine-family switch. Same SQL, different
runtime.

## How SQL files are applied

Both environments apply
[`sql/clickhouse/`](../../sql/clickhouse/) in lexical order:

```text
00_database.sql
10_analytics_events_queue.sql
20_analytics_ingest_log.sql
21_mv_queue_to_ingest_log.sql
30_analytics_raw.sql
31_mv_queue_to_raw.sql
projections/*.sql
materialized-views/*.sql
roles/00_roles.sql
roles/01_grants.sql
```

The migration runner is the responsibility of
[P4-002](../../docs/implementation/tasks/P4-002-clickhouse-ingestion.md);
this task only ships the SQL and the macro/Keeper configuration
that makes it valid in both modes.
