# P11-005: Backup and Retention Runbooks

Status: Done (merged in `618af87`)

## Goal

Define and document backup, restore, and retention policies for production operation.

## Required Reading

- [Redpanda Topics](../../architecture/03-redpanda-topics.md)
- [ClickHouse](../../architecture/07-clickhouse.md)
- [Control Plane](../../architecture/02-control-plane.md)

## Dependencies

- P1-001
- P1-002
- P4-002

## Write Scope

Allowed:

```text
docs/operations/
docs/deployment/
infra/
```

Forbidden:

```text
application code unless adding non-invasive scripts explicitly called by docs
```

## Implementation Notes

Cover:

- PostgreSQL backup and restore
- ClickHouse backup and restore
- Redpanda 90-day raw retention
- future raw object-storage archive
- Redis non-canonical/ephemeral expectations
- DLQ retention policy
- audit retention policy

### v1 backup/recovery targets

Implement and document these objectives. See [Production Readiness / Backup and Recovery](../../architecture/11-production-readiness.md) for the canonical table.

```text
PostgreSQL                  RPO 5 min   RTO 1 h    daily snapshot + continuous WAL streaming; 7-day PITR
ClickHouse analytics_raw    RPO 24 h    RTO 4 h    daily BACKUP TABLE to object storage
ClickHouse projections      N/A         per-projection rebuild   no backup; rebuild from analytics_raw
ClickHouse ingest_log       RPO 7 d     RTO 4 h    weekly snapshot, monthly cold archive
Redpanda                    RPO 0       RTO <1 h   in-cluster RF=3, min-ISR=2
Redis                       N/A         N/A        no backup
Secret provider             provider-managed
```

### Implementation specifics

- PostgreSQL: enable WAL archiving on the primary; stream to object storage; document the snapshot tooling chosen (pgBackRest, managed-service equivalent). Test PITR restore as part of staging operations at least quarterly.
- ClickHouse `analytics_raw`: scripted `BACKUP TABLE analytics_raw TO Disk('backups', 'analytics_raw_YYYY-MM-DD')` or equivalent for the managed deployment. Restore validation: load to a side table in staging and run a row-count + sample-query check.
- ClickHouse projections: document the rebuild path per projection. Rebuild jobs use the standard replay/rebuild workflow ([P7-005](./P7-005-clickhouse-rebuild-workflows.md)).
- Redpanda: rely on RF=3 for resilience. Broker replacement is an operational procedure documented in this runbook. Tiered storage / object archive is future work.
- Redis: make the non-durable role explicit. Ingester behavior when Redis is unavailable: continue accepting events; downstream idempotency remains the canonical dedupe layer.
- Audit retention: 2 years (matches [11-production-readiness.md](../../architecture/11-production-readiness.md) lifecycle defaults).
- DLQ retention: retain unresolved; 30 days after resolution.

### Restore validation

- Quarterly: restore PostgreSQL to staging from a recent snapshot + WAL, verify audit row count and a sample of replay job rows.
- Quarterly: restore one ClickHouse `analytics_raw` partition to a side table in staging, verify row count and a sample of dedupe queries.
- Document the validation script in `infra/backups/` or equivalent.

## Acceptance Criteria

- [ ] Backup/restore runbook exists.
- [ ] Retention defaults are documented and match the production-readiness lifecycle defaults.
- [ ] v1 RPO/RTO targets are documented per store and match the canonical table.
- [ ] PostgreSQL WAL streaming + daily snapshot procedure is documented with a chosen tool.
- [ ] ClickHouse `BACKUP TABLE` procedure is documented with a chosen object-storage target.
- [ ] Projection-rebuild path is documented per projection (or pointed to as a P7-005 dependency).
- [ ] Redis non-durable role is explicit, including ingester fallback behavior on Redis loss.
- [ ] Object-storage archive is marked future if not implemented.
- [ ] Restore validation scripts and a quarterly cadence are documented.

## Checks

Run where possible:

```text
rg -n "backup|restore|retention|archive|Redis" docs/operations docs/deployment
```

## Handoff

```text
Files changed:
  docs/operations/backup-and-retention.md        master runbook (PG + ClickHouse + Redpanda + Redis + DLQ + audit + drills)
  docs/deployment/data-classes.md                 one-page data-class/retention/regulatory/owner reference
  infra/backups/README.md                         10-line intro linking the scripts back to the runbook
  infra/backups/pg-dump.sh                        pg_dump --format=custom + rotation script (cron-safe, env-configurable)
  infra/backups/pg-restore.sh                     pg_restore wrapper for the restore drill, refuses to restore over an active primary
  infra/backups/clickhouse-backup.sh              BACKUP TABLE ... TO Disk('backup_disk', ...) wrapper, HTTP /query interface

Commands run:
  bash -n infra/backups/*.sh                      syntax OK (all 3)
  shellcheck infra/backups/*.sh                   clean (no findings)
  pnpm install --frozen-lockfile                  ok
  pnpm build                                      ok (required to seed cross-package type imports for typecheck)
  pnpm typecheck                                  ok (no changes to TS surface; docs-only task)
  pnpm lint                                       ok (biome + lint:clickhouse-imports)
  pnpm format:check                               ok
  pnpm test                                       ok (1185 passed, 1 skipped; scripts 59 passed)
  rg -n "backup|restore|retention|archive|Redis" docs/operations docs/deployment
                                                  finds expected hits across both new files

Checks passed:
  acceptance: Backup/restore runbook exists.                                              docs/operations/backup-and-retention.md
  acceptance: Retention defaults documented; match production-readiness lifecycle table.  docs/operations/backup-and-retention.md + docs/deployment/data-classes.md
  acceptance: v1 RPO/RTO targets documented; match canonical table.                       docs/operations/backup-and-retention.md "Recovery Objectives" mirrors 11-production-readiness.md
  acceptance: PostgreSQL WAL streaming + daily snapshot procedure documented.             docs/operations/backup-and-retention.md "PostgreSQL" (pgBackRest reference impl)
  acceptance: ClickHouse BACKUP TABLE procedure documented with object-storage target.    docs/operations/backup-and-retention.md "ClickHouse / Disk configuration" (S3 ref)
  acceptance: Projection-rebuild path documented (points to P7-005).                      docs/operations/backup-and-retention.md "Projection tables: rebuild, do not restore"
  acceptance: Redis non-durable role explicit; ingester fallback on Redis loss covered.   docs/operations/backup-and-retention.md "Redis"
  acceptance: Object-storage archive marked future.                                       docs/operations/backup-and-retention.md "Redpanda / What happens at 90 days" + "Future Extensions"
  acceptance: Restore validation scripts + quarterly cadence documented.                  docs/operations/backup-and-retention.md "Quarterly Recovery Drills" (3 blocks)

Known gaps:
  - audit_records scheduled purge cron is doc-only; physical purge job is not implemented in v1 (called out as future work in the runbook).
  - wal-archive.sh is referenced but intentionally not shipped — it's an operator-owned thin wrapper around the chosen archive backend (pgBackRest stanza / S3 / managed service equivalent); shipping a stub would constrain the operator's choice.
  - Object-storage upload step for pg_dump artifacts is deliberately not in pg-dump.sh; operators wrap the cron entry with their own `aws s3 cp` / `mc cp` / `rclone copy`. Documented in the script header.
  - No automated shell test harness exists in the repo; scripts validated with bash -n and shellcheck only.
```

