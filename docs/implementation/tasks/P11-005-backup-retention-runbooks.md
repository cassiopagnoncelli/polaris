# P11-005: Backup and Retention Runbooks

Status: Ready

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
Commands run:
Checks passed:
Known gaps:
```

