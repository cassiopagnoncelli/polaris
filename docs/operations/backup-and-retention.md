# Backup and Retention Runbook

Polaris is internal event infrastructure. Three different stores hold three
different kinds of state, and each has its own recovery model. This runbook
is the operator entry point for backup, restore, retention, and quarterly
recovery drills.

Binding architecture references:

- [Production Readiness / Backup and Recovery](../architecture/11-production-readiness.md#backup-and-recovery)
- [Production Readiness / Data Lifecycle Defaults](../architecture/11-production-readiness.md#data-lifecycle-defaults)
- [ClickHouse](../architecture/07-clickhouse.md)
- [RabbitMQ Streams](../architecture/03-rabbitmq-streams.md)
- [Control Plane](../architecture/02-control-plane.md)

The matching data-class one-pager lives at
[`docs/deployment/data-classes.md`](../deployment/data-classes.md). The
canonical scripts the runbook calls live in
[`infra/backups/`](../../infra/backups/).

## Recovery Objectives

This is the canonical table. It mirrors and binds to
[Production Readiness / Backup and Recovery](../architecture/11-production-readiness.md#backup-and-recovery)
— if the two disagree, the architecture doc wins and this runbook is fixed.

| Store | Holds | RPO | RTO | Strategy |
| --- | --- | --- | --- | --- |
| PostgreSQL | audit, replay jobs, processor runs, destination instances, operator tokens, API key hashes, schema/source registry, topic isolations, identity links | 5 min | 1 h | daily `pg_dump --format=custom` + continuous WAL streaming; 7-day point-in-time recovery |
| ClickHouse `analytics_raw` | deduped analytical facts | 24 h | 4 h (recent partitions) | daily `BACKUP TABLE` to object storage |
| ClickHouse projection tables | derived from `analytics_raw` via MVs | N/A | per-projection rebuild time | no backup; rebuild via [P7-005](../../agents/pm/kanban/done/P7-005-clickhouse-rebuild-workflows.md) |
| ClickHouse `analytics_ingest_log` | append-only landing log, 30-day TTL | 7 d | 4 h | weekly `BACKUP TABLE`, monthly cold archive |
| RabbitMQ | canonical event topics | 0 (RF=3, min-ISR=2) | <1 h broker replacement | in-cluster replication factor; tiered storage future work |
| Redis | dedupe windows, rate limits, processor caches | N/A | N/A | no backup; loss is acceptable transient duplicate increase, downstream idempotency handles |
| Per-project secrets | plaintext in PostgreSQL (`destinations.secret_value`, `project_config`) | covered by the PostgreSQL row above | covered above | no separate backup — but see the credential-material warning below |

Rules baked into the runbook:

- Backup tooling lives in `infra/backups/` and is the single source of
  truth for "how do I take a backup right now."
- Restore validation runs in staging every quarter — `pg_dump`,
  ClickHouse partition, and the WAL PITR loop. See
  [Quarterly Recovery Drills](#quarterly-recovery-drills).
- Audit records and operator tokens are the most compliance-sensitive
  PostgreSQL rows. The 5-minute RPO targets exactly those rows.
- ClickHouse projection tables are deliberately not backed up. The
  rebuild path runs through the standard replay/rebuild workflow
  ([P7-005](../../agents/pm/kanban/done/P7-005-clickhouse-rebuild-workflows.md)).
- **PostgreSQL backups contain live credentials.** This inverts what
  this runbook used to say. Per-project secrets — destination vendor
  tokens and sensitive `project_config` values — are stored as
  plaintext, so every `pg_dump`, every WAL archive and every replica
  carries them. Encrypt backups at rest, restrict who can restore one,
  and treat a leaked backup as a credential compromise requiring
  rotation of every affected destination
  ([Production Readiness / Secret Management](../architecture/11-production-readiness.md#secret-management)).

## PostgreSQL

PostgreSQL holds Polaris's mutable runtime / control state. Losing it
breaks every CLI mutation, every audit query, and every replay job
record. The recovery profile is the most aggressive of the three stores:
5 minute RPO and 1 hour RTO.

### What's in PostgreSQL

Per [`db/migrations/`](../../db/migrations/), the v1 control plane
schema covers:

| Table | Purpose | Retention | Class |
| --- | --- | --- | --- |
| `projects` | project registry | indefinite (operational manifest) | operational |
| `sources` | source registry per project / environment | indefinite | operational |
| `api_keys` | argon2id hashes + lifecycle metadata | active lifetime + 2 years after revoke | operational (hash-only, no plaintext) |
| `destinations` | destination instance configuration | indefinite | operational |
| `processor_activations` | enable / disable flags per processor version | indefinite | operational |
| `processor_runs` | per-run record (timestamps, metrics, status) | 1 year | operational |
| `audit_records` | one row per state-changing CLI command | 2 years | regulatory |
| `operator_tokens` | argon2id hashes of CLI credentials | active lifetime + 2 years after revoke | sensitive (hash-only, no plaintext) |
| `identity_links` | append-only identity edges from the identity resolver | identity retention policy ([P8-002](../../agents/pm/kanban/done/P8-002-identity-resolver-v1.md)) | pseudonymized PII |

`replay_jobs` and `delivery_records` land with P7-* and P9-007 and
follow the same backup model. They are listed in
[Production Readiness / Data Lifecycle Defaults](../architecture/11-production-readiness.md#data-lifecycle-defaults).

### Daily snapshot

Use [`infra/backups/pg-dump.sh`](../../infra/backups/pg-dump.sh) on a
cron schedule:

```bash
# /etc/cron.d/polaris-pg-backup
0 2 * * * polaris /opt/polaris/infra/backups/pg-dump.sh >>/var/log/polaris/pg-backup.log 2>&1
```

The script:

- Uses `pg_dump --format=custom --no-owner --no-acl` so the dump is
  parallel-restore-friendly and replays cleanly into a database with a
  different owner / ACL layout.
- Names the artifact `polaris-<UTC timestamp>.dump` so lexicographic
  ordering matches chronological ordering.
- Writes to `${POLARIS_BACKUP_DIR}` (default `/var/lib/polaris/backups/postgres`).
- Rotates files older than `${POLARIS_BACKUP_RETENTION_DAYS}` (default
  `14`).

Production deployments upload the dump artifact to object storage as
an additional copy. The script writes to the local backup directory by
default; pushing to object storage is an operator-supplied step (e.g.
a follow-up `aws s3 cp` line in the same cron entry). The runbook
deliberately keeps the script focused on the dump itself so the
operator's preferred object-storage tooling (AWS CLI, `mc`, `rclone`)
stays out of the script.

### Continuous WAL streaming

`pg_dump` alone gives ~24h RPO. The 5-minute RPO target requires
write-ahead-log streaming.

Production runs PostgreSQL with WAL archiving enabled:

```ini
# postgresql.conf — production
wal_level = replica
archive_mode = on
archive_command = '/opt/polaris/infra/backups/wal-archive.sh %f %p'
archive_timeout = 300                  # at most 5 min between flushes
```

The chosen tool for managed snapshots + WAL archiving in v1 is
**pgBackRest** when self-hosted, or the equivalent in a managed
Postgres service (AWS RDS automated backups + transaction logs, GCP
Cloud SQL automated backups + binlog, Azure Postgres Flexible Server
backup). The runbook treats pgBackRest as the reference implementation
and the managed-service equivalent as a drop-in.

`wal-archive.sh` is not shipped in this runbook — it's a thin
operator-owned wrapper that uploads `%p` to object storage (pgBackRest
stanza, S3, etc.) and exits 0 only on a confirmed durable write.
Failing the archive command intentionally blocks WAL recycling, which
is the correct backpressure when archive storage is unhealthy.

### Restore drill

[`infra/backups/pg-restore.sh`](../../infra/backups/pg-restore.sh) wraps
`pg_restore` for a clean restore into a target database:

```bash
# 1. Provision an empty target database.
createdb polaris_restore

# 2. Restore the latest dump into it.
POLARIS_RESTORE_DATABASE=polaris_restore \
  /opt/polaris/infra/backups/pg-restore.sh \
  /var/lib/polaris/backups/postgres/polaris-20260512T020000Z.dump

# 3. Spot-check row counts.
psql polaris_restore -c "SELECT count(*) FROM audit_records;"
psql polaris_restore -c "SELECT count(*) FROM api_keys WHERE status = 'active';"
psql polaris_restore -c "SELECT count(*) FROM operator_tokens WHERE status = 'active';"
```

The restore script:

- Uses `pg_restore --no-owner --no-acl --clean --if-exists` so the
  target database can be re-used across drills.
- Refuses to restore over a database that is currently a Polaris
  primary (it checks for the application name `polaris-control-plane`
  on active connections and aborts; the check is a courtesy, not a
  security boundary).

### Point-in-time recovery

Point-in-time recovery (PITR) is the load-bearing capability for the
5-minute RPO target. Procedure:

1. Provision a fresh PostgreSQL instance with the same major version
   as the source.
2. Restore the most recent base backup (pgBackRest snapshot or
   managed-service base).
3. Replay WAL up to the chosen recovery target (`recovery_target_time`
   or `recovery_target_xid`).
4. Promote the recovered instance once the target is reached.
5. Validate row counts on `audit_records`, `operator_tokens`, and
   `api_keys`.
6. Repoint application connection strings.

PITR is exercised quarterly in staging — see
[Quarterly Recovery Drills](#quarterly-recovery-drills).

## ClickHouse

ClickHouse is the analytical engine. Its recovery model is split:
`analytics_raw` and `analytics_ingest_log` are backed up; projection
tables are not — they're rebuilt.

### TTL is the retention mechanism

ClickHouse retention is driven by table-level `TTL` clauses, not by
operator-run delete jobs. Per
[`sql/clickhouse/`](../../sql/clickhouse/):

| Table | Engine | TTL | Notes |
| --- | --- | --- | --- |
| `polaris.analytics_ingest_log` | `MergeTree` / `ReplicatedMergeTree` | `INTERVAL 30 DAY` on `ingested_at` | Append-only landing log. Duplicates expected. |
| `polaris.analytics_raw` | `ReplacingMergeTree` / `ReplicatedReplacingMergeTree` (`_version`) | `INTERVAL 400 DAY` on `occurred_at` | Deduped analytical facts. Never queried without explicit dedupe. |
| `polaris.<projection>` | per-projection | per-projection (default 400 days) | Read surface for dashboards. |

ClickHouse evaluates TTL during background merges. A row that is past
its TTL window will be dropped in a future merge — there is no
guaranteed instant deletion. To force TTL evaluation (for example after
shortening a window):

```sql
ALTER TABLE polaris.analytics_raw
  MODIFY TTL toDateTime(occurred_at) + INTERVAL 400 DAY;

ALTER TABLE polaris.analytics_raw MATERIALIZE TTL;
```

`MATERIALIZE TTL` rewrites parts so the new policy is applied
immediately. It is expensive on hot partitions — schedule it during a
maintenance window.

### Why backups use `argMax`-aware shapes

`analytics_raw` is a `ReplacingMergeTree`. Between merges, duplicate
rows for the same `(project_id, environment, event, event_id)` coexist
in the table. The architecture doc spells out the rule:

> `analytics_raw` is never queried without explicit dedupe. Plain
> `SELECT *` on `analytics_raw` is wrong.

See [ClickHouse / Query Patterns](../architecture/07-clickhouse.md#query-patterns).

Backups via `BACKUP TABLE` capture every part — duplicates included —
because that's the on-disk truth. Restores keep the duplicates and rely
on the same merge behavior to converge them. That's the correct
trade-off: backing up "the table as it is now" is what makes restores
deterministic.

When the runbook says "verify a restored partition," it always means
running an `argMax`- or `count(DISTINCT event_id)`-shaped query. The
[restore drill](#restore-drill-1) below uses both.

### Daily snapshot

Use [`infra/backups/clickhouse-backup.sh`](../../infra/backups/clickhouse-backup.sh)
on a cron schedule:

```bash
# /etc/cron.d/polaris-clickhouse-backup
0 3 * * * polaris /opt/polaris/infra/backups/clickhouse-backup.sh analytics_raw >>/var/log/polaris/clickhouse-backup.log 2>&1
0 4 * * 0 polaris /opt/polaris/infra/backups/clickhouse-backup.sh analytics_ingest_log >>/var/log/polaris/clickhouse-backup.log 2>&1
```

The script wraps `clickhouse-client --query`:

```sql
BACKUP TABLE polaris.<table>
  TO Disk('backup_disk', '<table>-<utc-timestamp>.zip')
  SETTINGS compression_method = 'zstd', compression_level = 3;
```

This is the canonical ClickHouse BACKUP syntax (since 22.x). It writes
to a configured **backup disk**, not a filesystem path — disk routing
is a server-side concern that lets the same SQL work whether the disk
is local, S3, or a managed-service equivalent.

### Disk configuration

The runbook expects an operator-supplied disk called `backup_disk` in
the ClickHouse server config. Two reference configurations:

**Local filesystem (dev / staging)**

```xml
<!-- /etc/clickhouse-server/config.d/backup_disk.xml -->
<clickhouse>
  <storage_configuration>
    <disks>
      <backup_disk>
        <type>local</type>
        <path>/var/lib/clickhouse/backups/</path>
      </backup_disk>
    </disks>
  </storage_configuration>
  <backups>
    <allowed_disk>backup_disk</allowed_disk>
  </backups>
</clickhouse>
```

**Object storage (production, AWS S3 reference)**

```xml
<!-- /etc/clickhouse-server/config.d/backup_disk.xml -->
<clickhouse>
  <storage_configuration>
    <disks>
      <backup_disk>
        <type>s3</type>
        <endpoint>https://s3.us-east-1.amazonaws.com/polaris-clickhouse-backups/</endpoint>
        <use_environment_credentials>true</use_environment_credentials>
      </backup_disk>
    </disks>
  </storage_configuration>
  <backups>
    <allowed_disk>backup_disk</allowed_disk>
  </backups>
</clickhouse>
```

`<allowed_disk>` is required — ClickHouse refuses `BACKUP` /
`RESTORE` to disks that are not explicitly listed.

### Restore drill

```bash
# 1. Restore the backup to a side table in staging.
clickhouse-client --query "
  RESTORE TABLE polaris.analytics_raw AS polaris.analytics_raw_restored
    FROM Disk('backup_disk', 'analytics_raw-20260512T030000Z.zip')
"

# 2. Verify row count on a recent partition (no FINAL, no plain SELECT).
clickhouse-client --query "
  SELECT count(DISTINCT event_id)
  FROM polaris.analytics_raw_restored
  WHERE occurred_at >= now() - INTERVAL 1 DAY
"

# 3. Sample-check a few well-known event_ids with the canonical argMax shape.
clickhouse-client --query "
  SELECT
    project_id, environment, event, event_id,
    argMax(properties_json, _version) AS properties_json,
    argMax(_version, _version) AS latest_version
  FROM polaris.analytics_raw_restored
  WHERE occurred_at >= now() - INTERVAL 1 DAY
  GROUP BY project_id, environment, event, event_id
  LIMIT 10
"

# 4. Drop the side table once verification passes.
clickhouse-client --query "DROP TABLE polaris.analytics_raw_restored"
```

The restore script does not auto-drop side tables. Verification is an
operator decision; the drop step is explicit so a half-verified
restore is never silently discarded.

### Projection tables: rebuild, do not restore

Projection tables (e.g. `event_daily_counts`,
`merchant_daily_metrics`) are intentionally not in any backup. They are
derived state. Restoring a stale projection alongside fresh
`analytics_raw` would produce inconsistent reads.

Recovery path:

1. Confirm `analytics_raw` is current (recent or just restored).
2. Drop the projection table.
3. Recreate it from
   [`sql/clickhouse/projections/`](../../sql/clickhouse/projections/).
4. Run the matching rebuild job through P7-005's
   `replay/rebuild` workflow. The MV defined in
   `sql/clickhouse/materialized-views/` will pick up new inserts to
   `analytics_raw`; the historical fill is the rebuild job's
   responsibility.

The rationale for "rebuild not restore" lives in
[ClickHouse / Replay and Rebuild](../architecture/07-clickhouse.md#replay-and-rebuild)
and is reinforced by Production Readiness:

> ClickHouse projection rebuilds run through the standard replay/rebuild
> workflow ([P7-005](../../agents/pm/kanban/done/P7-005-clickhouse-rebuild-workflows.md)),
> not as ad-hoc SQL.

### Verifying TTL is honored

Quarterly check, run during the recovery drill:

```sql
-- Confirm the configured TTL clause matches what the SQL files declare.
SELECT name, engine, partition_key, sorting_key, primary_key, ttl
FROM system.tables
WHERE database = 'polaris' AND name IN ('analytics_raw', 'analytics_ingest_log');

-- Confirm rows past TTL are being dropped (no rows older than 30d in ingest_log).
SELECT min(ingested_at) FROM polaris.analytics_ingest_log;
-- expect: >= now() - INTERVAL 30 DAY

-- Confirm rows past TTL are being dropped (no rows older than 400d in raw).
SELECT min(occurred_at) FROM polaris.analytics_raw;
-- expect: >= now() - INTERVAL 400 DAY
```

If the `min()` query returns a timestamp older than the TTL window,
trigger a manual `MATERIALIZE TTL`:

```sql
ALTER TABLE polaris.analytics_raw MATERIALIZE TTL;
ALTER TABLE polaris.analytics_ingest_log MATERIALIZE TTL;
```

## RabbitMQ

RabbitMQ is not "backed up" in the conventional sense. Its recovery
profile is in-cluster: RF=3 with `min.insync.replicas=2`. A broker
failure is absorbed; broker replacement is the routine operational
procedure.

### Operational retention model

Per
[Production Readiness / Data Lifecycle Defaults](../architecture/11-production-readiness.md#data-lifecycle-defaults):

| Topic | Retention | Purpose |
| --- | --- | --- |
| `raw.events` | 90 days | Canonical immutable raw event log |
| `identity.events` | 30 days | Identity resolver output |
| `enriched.events` | 30 days | GeoIP-enriched events |
| `attribution.events` | 30 days | Attribution engine output |
| `analytics.events` | 30 days | ClickHouse ingestion source |
| retry topics | 7 days | Per-consumer retry queues |
| DLQ topics | retain unresolved + 30 days after resolution | Dead-letter records |

The active levers are:

```ini
# RabbitMQ topic config — example for raw.events
retention.ms=7776000000        # 90 days
segment.ms=86400000            # 1 day per segment
segment.bytes=1073741824       # 1 GiB cap per segment
```

Polaris uses time-based retention first; segment.bytes acts as a cap so
a sudden traffic surge cannot blow up a single segment.

### What happens at 90 days

Beyond 90 days, `raw.events` segments are deleted and replay from raw
becomes impossible. The replayability principle in Polaris is explicit:

> Replayability within the operational retention window is a primary
> architectural constraint.

It is also explicit that the window is bounded:

> Object-storage raw archive is a future extension. Until it exists,
> RabbitMQ `raw.events` retention defines the practical raw replay
> window. The replayability principle is bounded by this window —
> Polaris does not promise replay beyond the operational retention
> window in v1.

Two operational consequences:

1. Long-horizon replays (60+ days) need to be scheduled and executed
   inside the retention window. Operators planning a multi-quarter
   rebuild should batch it within the 90-day budget.
2. ClickHouse `analytics_raw` is the long-horizon record for
   analytics-shaped reasoning. It holds 400 days. It is not a
   substitute for `raw.events` (different envelope, different
   semantics), but it survives the RabbitMQ retention window for
   analytical purposes.

Object-storage raw archive is honest future work, gated on first
production volume data. It is referenced in
[Production Readiness / Open Production Decisions](../architecture/11-production-readiness.md#open-production-decisions)
and is intentionally not in this runbook's v1 scope.

### Broker replacement

Broker replacement is the only recovery procedure for RabbitMQ in v1.
Outline (cluster operator owns the full runbook; this is the Polaris
view of it):

1. Drain the failing broker (`rpk rabbitmq admin brokers decommission`).
2. Provision a replacement node with the same disk layout.
3. Add it to the cluster (`rpk rabbitmq admin brokers add`).
4. Wait for partition rebalance — `min.insync.replicas=2` keeps
   producers writable throughout.
5. Confirm `rpk cluster health` returns green and the new broker is
   serving partitions.

If RF=3 and ISR=2 still hold during the replacement, producer-visible
RPO stays at zero.

## Redis

Redis is explicitly non-durable in Polaris. Per
[Production Readiness / Backup and Recovery](../architecture/11-production-readiness.md#backup-and-recovery):

> Redis: no backup; loss = transient duplicate increase, downstream
> handles.

What Redis holds:

- 15-minute ingress dedupe window (per-project override up to 24h)
- short-TTL rate-limit counters
- processor-specific ephemeral caches

What happens on Redis loss:

- The ingester **continues accepting events**. Producer-side retries
  during the gap will produce duplicate `event_id` entries in
  `raw.events`. This is operationally tolerable.
- Downstream consumers remain the canonical idempotency layer. From
  [Claude Instructions / Ingestion](../instructions/claude.md):

  > treat ingress dedupe as the canonical idempotency layer (downstream
  > consumers must remain idempotent)

  i.e. duplicate raw events are expected and absorbed by the rest of
  the pipeline.
- Rate limits temporarily reset. Worst case is a brief burst window
  before counters re-warm.

There is no backup procedure. If Redis is unavailable, restart it
empty; no restore step is required.

## DLQ retention policy

DLQ topics retain records until they are resolved, then for 30 days
after resolution. This matches
[Production Readiness / Data Lifecycle Defaults](../architecture/11-production-readiness.md#data-lifecycle-defaults).

Operational notes:

- Unresolved DLQ records are never auto-purged. A growing DLQ is a
  signal, not a cost problem.
- Resolution is recorded via the destination-DLQ triage runbook
  ([P10-006](../../agents/pm/kanban/done/P10-006-dlq-triage-runbook.md)
  and the destination DLQ work in
  [P9-007](../../agents/pm/kanban/done/P9-007-destination-delivery-records-and-dlq-triage.md)).
- The 30-day post-resolution retention exists so an operator can
  re-investigate a "we marked this fixed but it's still broken"
  case before the record is dropped.

DLQ records carry no plaintext secrets. The destination consumer
runtime ([P9-001](../../agents/pm/kanban/done/P9-001-destination-consumer-runtime.md))
is responsible for redacting secret material before any DLQ write.

## Attribution chain retention

`attribution_touchpoint_chains` rows for **attribution-engine v2** are
prunable once idle for longer than the processor's 90-day attribution
window. v1 rows are **not** prunable at all.

The asymmetry is semantic, not a policy preference:

- v2 resets a chain after a 90-day inactivity gap, so a row idle beyond
  the window can never be consulted again — the next event for that
  identifier is guaranteed to open a new chain whether or not the old
  row exists. Deleting it is provably free of semantic effect.
- v1 has no window. A v1 chain is consulted however old it is, so
  deleting one CHANGES OUTPUT: the next touchpoint would emit a
  `first_touch_assigned` it otherwise would not. That is a new processor
  version, not a retention decision.

Unlike the audit and DLQ policies above, this one has an implementation:

```bash
# Count first. Writes no audit row.
polaris processors chains-prune --version v2 --dry-run

# Prune. Writes one audit row for the operation.
polaris processors chains-prune --version v2

# Narrow by scope, or be more conservative than the window.
polaris processors chains-prune --version v2 --project storefront --env production
polaris processors chains-prune --version v2 --idle 15552000   # 180 days
```

The command refuses `--version v1` and refuses an `--idle` shorter than
the version's own window — both would delete rows the engine can still
read. The guard lives in the mutation
(`@polaris/shared-control-plane-db`), so a future scheduled job or the
control-plane API inherits it rather than reimplementing it.

### Scheduling it

[`infra/backups/prune-attribution-chains.sh`](../../infra/backups/prune-attribution-chains.sh)
wraps the command for cron:

[`infra/backups/crontab.example`](../../infra/backups/crontab.example) is a
ready-to-install `/etc/cron.d` schedule carrying this job alongside the
backups:

```bash
sudo install -m 0644 -o root -g root infra/backups/crontab.example /etc/cron.d/polaris
```

Connection settings come from an operator-owned `/etc/polaris/retention.env`
that each entry sources, because cron runs with almost no environment and the
crontab itself is checked in.

Daily is ample — the window is 90 days, so eligibility does not change
quickly, and the delete is a bounded index scan.

#### One entry per environment, and only one of them needs a credential

The file ships three prune entries rather than one:

| Entry | Sources | Needs a token |
| --- | --- | --- |
| `POLARIS_PRUNE_ENV=development` | `retention.env` | no |
| `POLARIS_PRUNE_ENV=staging` | `retention.env` | no |
| `POLARIS_PRUNE_ENV=production` | `retention.env` + `retention-production.env` | **yes** |

An *unscoped* prune — `POLARIS_PRUNE_ENV` unset — means every environment
including production, so the CLI treats it as a production mutation and
refuses it without `POLARIS_OPERATOR_TOKEN`. Splitting the entries keeps
that credential on the one job that needs it instead of handing a
production token to a job that only ever touches development.

**You do not need production to start using this.** The development and
staging entries need nothing but a host, the `polaris` CLI, and database
reachability. If the production operator token is not provisioned yet,
install the file and comment out the production line — the other two
begin doing useful work immediately, and uncommenting later is the whole
of the remaining change. Only that third line is production-gated; the
schedule as a whole is deployment-gated.

Keep `retention-production.env` root-owned and `0600`. It holds a
credential that can delete rows, and the audit row for a run that used it
records `operator_token` plus the operator's label rather than a bare
`cli` — which is the point of putting it there.

Unlike its sibling scripts here, this one is not dependency-free: it
shells out to the `polaris` CLI rather than issuing SQL. That is the
point. A bare `DELETE ... WHERE last_observed_at < now() - interval '90
days'` in a cron entry would bypass both refusals and leave no audit row.
The script cannot be talked into an unsafe delete because it does not
know how to delete anything itself.

A refusal exits non-zero so the cron entry fails loudly rather than
reading as a quiet success. Configuration is by environment
(`POLARIS_PRUNE_VERSION`, `POLARIS_PRUNE_PROJECT`, `POLARIS_PRUNE_ENV`,
`POLARIS_PRUNE_IDLE_SECONDS`, `POLARIS_PRUNE_DRY_RUN`,
`POLARIS_OPERATOR_TOKEN`); defaults are documented at the top of the
script.

There is no locking. Two overlapping runs both issue the same bounded
DELETE; the second finds nothing and writes no audit row.

Note the interaction with a version cutover: v1's chains must survive
until rollback is off the table. See
[Processor Version Cutover](./processor-version-cutover.md) step 8.

## Audit retention policy

`audit_records` retention is **2 years**, matching
[Production Readiness / Data Lifecycle Defaults](../architecture/11-production-readiness.md#data-lifecycle-defaults).

Audit retention is regulatory, not operational. The 2-year window
covers most internal compliance review cycles. Implementation notes:

- Audit rows live in PostgreSQL and ride the same `pg_dump` + WAL
  recovery model as the rest of the control plane.
- There is **no** background purge job in v1. The 2-year window is a
  policy commitment; physical deletion lands when the first scheduled
  purge job is built. Until then, audit rows stay forever — which is
  safer than premature deletion.
- A future scheduled purge will live as a CLI command under
  `polaris audit purge --older-than 2y` and write its own audit row.

## Quarterly Recovery Drills

Recovery is exercised in staging once per quarter. The drill is the
load-bearing validation that the recovery objectives in the
[table above](#recovery-objectives) are real.

Schedule:

- **Q1, Q2, Q3, Q4 — first Tuesday of the quarter**, 14:00 UTC.
- Drill runs in staging only. Production is never the drill target.
- The drill must complete within one working day; failure to complete
  is its own operational signal.

The drill consists of three blocks:

### Block 1: PostgreSQL restore from yesterday's dump

1. Pick the most recent `polaris-*.dump` artifact from staging
   backups.
2. Run [`infra/backups/pg-restore.sh`](../../infra/backups/pg-restore.sh)
   into `polaris_restore_drill`.
3. Validate row counts against a known-good baseline from the dump's
   own metadata:

    ```bash
    pg_restore --list <dump> | head -40        # inspect target tables
    psql polaris_restore_drill -c "
      SELECT 'audit_records' AS table, count(*) FROM audit_records UNION ALL
      SELECT 'operator_tokens', count(*) FROM operator_tokens UNION ALL
      SELECT 'api_keys', count(*) FROM api_keys UNION ALL
      SELECT 'processor_runs', count(*) FROM processor_runs UNION ALL
      SELECT 'identity_links', count(*) FROM identity_links
    "
    ```

4. Record results in the quarterly drill log.

### Block 2: PostgreSQL PITR loop

1. From the most recent base backup + WAL archive, restore to a
   point-in-time 30 minutes before the drill start.
2. Promote.
3. Confirm `audit_records` count matches the count at the chosen
   point-in-time.
4. Record results.

PITR is the harder of the two PostgreSQL paths and the one that
validates the 5-minute RPO claim. A drill failure here is the only
acceptable reason to renegotiate the RPO target with stakeholders.

### Block 3: ClickHouse partition restore + argMax sanity

1. Pick the most recent `analytics_raw-*.zip` backup.
2. `RESTORE TABLE polaris.analytics_raw AS polaris.analytics_raw_restored ...`
3. Run the argMax sanity query on a recent partition:

    ```sql
    SELECT
      project_id, environment, event, event_id,
      argMax(properties_json, _version) AS properties_json,
      argMax(_version, _version) AS latest_version
    FROM polaris.analytics_raw_restored
    WHERE occurred_at >= now() - INTERVAL 1 DAY
    GROUP BY project_id, environment, event, event_id
    LIMIT 100;
    ```

4. Run the `count(DISTINCT event_id)` shape on the same partition and
   confirm it agrees (within a tolerance for in-flight rows) with the
   live `analytics_raw` count.
5. `DROP TABLE polaris.analytics_raw_restored`.

### Drill log

Each drill produces one entry:

```text
quarter: 2026-Q2
date: 2026-04-07
block_1_pg_restore: PASS  (drill duration 11 min)
block_2_pg_pitr: PASS     (drill duration 38 min, RPO 4m12s)
block_3_ch_partition: PASS (drill duration 22 min)
operator: alice@polaris.dev
notes: -
```

A failed block must be re-run in the same quarter once the underlying
issue is fixed. The drill is not "done" with a partial result.

## Future Extensions

Honest future work, not v1 scope:

- **Object-storage raw archive**. RabbitMQ tiered storage or an
  out-of-cluster archive of `raw.events`. Unblocks replay beyond the
  90-day window. Decision deferred until first-production-month volume
  data exists (see
  [Production Readiness / Open Production Decisions](../architecture/11-production-readiness.md#open-production-decisions)).
- **Cross-region backup replication**. v1 is single-region. Cross-region
  backup replication lands with the multi-region work — not before.
- **Automated backup verification.** Today's drill is a quarterly human
  cadence. An automated nightly "restore a 1% sample of yesterday's
  dump and verify rowcounts" cron is a natural follow-up once the
  staging environment can host it without operator attention.
- **`audit_records` scheduled purge.** The 2-year retention policy is
  in the doc; the physical purge cron is future work as noted in
  [Audit retention policy](#audit-retention-policy).

## The raw.events archive

`async/warehouse/archiver/v1` consumes `raw.events` and writes it to
object storage as partitioned NDJSON. It is not a backup — nothing is
restored from it — it is a **replay source** that outlives the stream's
retention window.

### Why it exists

The stream keeps 90 days. Everything that replays was bounded by that,
and the bound was not cosmetic: `polaris profiles rebuild` truncates a
project's profile plane and rebuilds it from `raw.events`, so a customer
of five years came out of an un-merge with a `first_seen_at` of last
quarter. See
[`runbook-profile-rebuild.md`](runbook-profile-rebuild.md).

With the archive, `polaris replay create` accepts a `--from` older than
retention when the bucket covers it, the planner marks the job
`source_kind: archive` (or `mixed`, when the window crosses the
boundary), and the executor reads objects instead of attaching to a
stream. Everything downstream is unchanged — same plan, same replay
headers, same destination guardrails.

### Layout

```
<prefix>/v1/<project_id>/<environment>/<YYYY-MM-DD>/<stream>/<first>-<last>.ndjson
<prefix>/v1/<project_id>/<environment>/<YYYY-MM-DD>/_manifest/<stream>.ndjson
```

- The date is the events' `occurred_at` in **UTC**, not the archiver's
  wall clock. Replay windows are event-time, so a window of "March 3rd"
  is answerable by listing one prefix.
- Offsets are zero-padded to 20 digits so S3's lexicographic listing is
  also offset order.
- `project` precedes `environment` so a bucket policy can scope a role to
  one project by prefix.
- The manifest records each object's event-time range, so a one-hour
  replay does not download a whole day. It is an optimisation: a missing
  manifest costs a listing, never data.

### Bucket lifecycle

Polaris writes and never deletes. **Retention of the archive is an S3
lifecycle policy, not a Polaris setting**, which is deliberate — the
archive is the last copy of the raw event stream, and a service that
could delete it is a service that can be made to delete it.

Set the policy to the project's actual data-retention obligation from
[`docs/deployment/data-classes.md`](../deployment/data-classes.md).
Objects are immutable once written, so a transition to infrequent-access
or glacier-class storage after 90 days is safe and is what most
deployments want: the archive is read during incidents, not daily.

Two constraints on any policy you set:

- **Do not expire below the rebuild depth you intend to support.** The
  archive's first day is the floor `polaris profiles rebuild` reaches;
  expiring objects silently lowers it.
- **Do not enable a lifecycle rule that rewrites or re-encodes objects.**
  Replay republishes the bytes the producer serialised. That is why the
  archive is NDJSON and not Parquet, and it is why nothing may re-encode
  it in place.

### What to watch

- `polaris_processor_events_failed_total{processor_name="archiver",reason="put_failed"}`
  — every one of these holds the consumer checkpoint back. That is the
  design (the checkpoint never outruns object storage), but a checkpoint
  that stops moving is only survivable for as long as the stream's own
  retention window. Treat sustained put failures as an incident with a
  90-day fuse.
- `reason="unparseable_occurred_at"` — events with no usable timestamp
  are skipped, not filed under today. Filing them under the archiver's
  clock would hide them from a replay of the day they happened.

## See also

- [`docs/deployment/data-classes.md`](../deployment/data-classes.md) —
  one-pager: data class, retention, regulatory class, retention owner.
- [`infra/backups/README.md`](../../infra/backups/README.md) —
  short intro to the backup scripts referenced from this runbook.
- [Architecture: ClickHouse](../architecture/07-clickhouse.md) — query
  patterns, TTL, engine families.
- [Architecture: Production Readiness](../architecture/11-production-readiness.md)
  — recovery objectives, data lifecycle defaults, open decisions.
- [Development: Observability](../development/observability.md) —
  operator entry point for metrics, logs, traces.
