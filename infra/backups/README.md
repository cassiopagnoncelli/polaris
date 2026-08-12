# Polaris Backup and Retention Scripts

Operator-facing scripts referenced from the master runbook at
[`docs/operations/backup-and-retention.md`](../../docs/operations/backup-and-retention.md).

| Script | Purpose |
| --- | --- |
| [`pg-dump.sh`](./pg-dump.sh) | Daily `pg_dump --format=custom` snapshot of the Polaris control-plane database; rotates artifacts older than `POLARIS_BACKUP_RETENTION_DAYS`. |
| [`pg-restore.sh`](./pg-restore.sh) | `pg_restore` wrapper for the runbook's restore drill; refuses to restore over an active Polaris primary. |
| [`clickhouse-backup.sh`](./clickhouse-backup.sh) | Wraps `BACKUP TABLE ... TO Disk('backup_disk', ...)` for `analytics_raw` and `analytics_ingest_log`. |
| [`crontab.example`](./crontab.example) | Ready-to-install `/etc/cron.d` schedule for the jobs below. |
| [`prune-attribution-chains.sh`](./prune-attribution-chains.sh) | Deletes `attribution_touchpoint_chains` rows the processor's attribution window has already made unreadable. Wraps the audited CLI command rather than issuing SQL, so the v1 refusal cannot be bypassed. |

Install the schedule with:

```bash
sudo install -m 0644 -o root -g root infra/backups/crontab.example /etc/cron.d/polaris
```

Connection settings live in an operator-owned `/etc/polaris/retention.env`
that each job sources — cron runs with almost no environment, and this file
is in the repository, so it carries no credentials.

All scripts are safe to schedule from cron. The backup scripts are
dependency-free (just `bash` + the relevant client tool);
`prune-attribution-chains.sh` additionally needs the `polaris` CLI,
deliberately — the safety rules that decide which chains may be deleted
live in the audited mutation behind that command, and raw SQL in a cron
entry would bypass them. Configuration is via environment
variables; defaults are documented at the top of each script.

The matching one-page reference for what gets backed up and why lives
at [`docs/deployment/data-classes.md`](../../docs/deployment/data-classes.md).
