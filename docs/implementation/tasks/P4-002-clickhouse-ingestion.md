# P4-002: ClickHouse Ingestion Integration

Status: Review

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

- [x] ClickHouse SQL can be applied locally.
- [x] Kafka Engine table points at `analytics.events`.
- [x] `analytics_ingest_log` exists.
- [x] `analytics_raw` exists.
- [x] A basic query path is documented or scripted.

## Checks

Run where possible:

```text
docker compose up -d
```

## Handoff

```text
Files changed:
  package.json                                            (+4 scripts)
  scripts/clickhouse-migrate.mjs                          (new)
  scripts/clickhouse-bootstrap-local.mjs                  (new)
  scripts/clickhouse-query.mjs                            (new)
  scripts/__tests__/clickhouse-migrate.test.ts            (new)
  infra/clickhouse/init/01_local_users.sql                (new)
  infra/clickhouse/README.md                              (updated apply-procedure section)

Files audited and confirmed correct (no changes):
  sql/clickhouse/00_database.sql
  sql/clickhouse/10_analytics_events_queue.sql              (Kafka Engine, JSONEachRow, analytics.events)
  sql/clickhouse/20_analytics_ingest_log.sql                (MergeTree append-only)
  sql/clickhouse/21_mv_queue_to_ingest_log.sql              (MV: queue -> ingest_log)
  sql/clickhouse/30_analytics_raw.sql                       (ReplacingMergeTree, _version)
  sql/clickhouse/31_mv_queue_to_raw.sql                     (MV: queue -> raw, flattens JSON)
  sql/clickhouse/projections/40_event_daily_counts.sql      (SummingMergeTree projection)
  sql/clickhouse/materialized-views/41_mv_raw_to_event_daily_counts.sql  (argMax MV)
  sql/clickhouse/roles/00_roles.sql                         (polaris_service, polaris_operator)
  sql/clickhouse/roles/01_grants.sql                        (correct grants per architecture)

Commands run:
  pnpm install
  pnpm build
  pnpm typecheck                                            (passes)
  pnpm test                                                 (passes — 878 workspace + 43 script tests)
  pnpm lint                                                 (passes — biome + clickhouse-imports)
  pnpm clickhouse:migrate --dry-run                         (10 files, 19 statements parsed)
  pnpm clickhouse:bootstrap-local --dry-run                 (10 + 1 files, 19 + 4 statements parsed)
  node scripts/clickhouse-query.mjs                         (usage banner)

Checks passed:
  pnpm typecheck, pnpm test, pnpm lint, all dry-runs verify SQL parses cleanly.

Known gaps:
  * docker compose up -d / pnpm clickhouse:migrate against a live ClickHouse
    not exercised in this worker — Docker daemon was unavailable. The unit
    tests cover the runner's tokenizer, ordering, and error propagation;
    end-to-end "produce to Redpanda -> ClickHouse selects row" verification
    is owned by P5-001 vertical-slice smoke.
  * Local Docker Compose service env (CLICKHOUSE_USER=polaris, role admin)
    must run `pnpm clickhouse:bootstrap-local` once so services can connect
    as polaris_service / polaris_operator. The compose file itself does not
    auto-apply DDL on container start — that's intentional (production
    parity; migrations are deploy-time, not container-start).
  * `analytics_events_replay_mv` was investigated and NOT created — the
    architecture (07-clickhouse.md, 05-processors-and-replay.md) does not
    specify a separate replay Kafka topic. Replay events produce a higher
    `_version` through the same `analytics.events` topic; ReplacingMergeTree
    + argMax handle dedupe transparently.

Design notes for reviewers:
  * The migration runner is dependency-free on purpose: it uses Node 22's
    native fetch against the ClickHouse HTTP /query endpoint, not
    @clickhouse/client. The architecture's lint rule allows shared-clickhouse
    to be the only @clickhouse/client importer; a build-time migration tool
    is a different concern and the script's portability matters more.
  * Idempotency comes from `CREATE ... IF NOT EXISTS` in the DDL, not from
    a migrations ledger table. Re-running converges.
  * `infra/clickhouse/init/` is local/dev-only. Production users come from
    the secret provider (P11-004), not from a checked-in SQL file with
    well-known passwords.
```

