# Polaris Backup Scripts

Operator-facing scripts referenced from the master runbook at
[`docs/operations/backup-and-retention.md`](../../docs/operations/backup-and-retention.md).

| Script | Purpose |
| --- | --- |
| [`pg-dump.sh`](./pg-dump.sh) | Daily `pg_dump --format=custom` snapshot of the Polaris control-plane database; rotates artifacts older than `POLARIS_BACKUP_RETENTION_DAYS`. |
| [`pg-restore.sh`](./pg-restore.sh) | `pg_restore` wrapper for the runbook's restore drill; refuses to restore over an active Polaris primary. |
| [`clickhouse-backup.sh`](./clickhouse-backup.sh) | Wraps `BACKUP TABLE ... TO Disk('backup_disk', ...)` for `analytics_raw` and `analytics_ingest_log`. |

All scripts are dependency-free (just `bash` + the relevant client tool)
and safe to schedule from cron. Configuration is via environment
variables; defaults are documented at the top of each script.

The matching one-page reference for what gets backed up and why lives
at [`docs/deployment/data-classes.md`](../../docs/deployment/data-classes.md).
