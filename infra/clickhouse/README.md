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
    macros.xml                local/dev macros: {replicated} = '', {cluster} = polaris_local
    macros-production.xml     production macros: {replicated} = 'Replicated', {cluster} = polaris
    cluster.xml               local single-node `polaris_local` cluster definition
    keeper.xml                embedded ClickHouse Keeper config (production only)
  compose/
    docker-compose.production.yml   production-mode compose snippet (ClickHouse + embedded Keeper)
  init/
    01_local_users.sql        local/dev users tied to polaris_service / polaris_operator roles
  users.d/                    optional XML user overrides (empty by default)
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
[`sql/clickhouse/`](../../sql/clickhouse/) in lexical order via
[`scripts/clickhouse-migrate.mjs`](../../scripts/clickhouse-migrate.mjs):

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

The runner is idempotent: SQL files use `CREATE ... IF NOT EXISTS`
everywhere and grants are additive, so re-running the runner converges.
Invoke it as:

```bash
pnpm clickhouse:migrate              # apply (uses CLICKHOUSE_* env vars)
pnpm clickhouse:migrate:dry-run      # plan only, no I/O
```

For local/dev, an additional bootstrap step provisions concrete
users tied to the `polaris_service` and `polaris_operator` roles so
the workspace SDK + CLI can authenticate non-default profiles:

```bash
pnpm clickhouse:bootstrap-local      # migrate, then apply infra/clickhouse/init/*.sql
```

Production never applies `infra/clickhouse/init/` — those users are
provisioned by the secret provider
([P11-004](../../docs/implementation/tasks/P11-004-production-secret-provider.md)).

After migrations apply, a thin smoke-query helper exists for quick
inspection:

```bash
pnpm clickhouse:query ping                       # GET /ping
pnpm clickhouse:query schema                     # list polaris.* objects
pnpm clickhouse:query ingest-log --limit=20      # tail analytics_ingest_log
pnpm clickhouse:query raw-count                  # count(DISTINCT event_id)
pnpm clickhouse:query event-daily-counts         # tail the example projection
```
