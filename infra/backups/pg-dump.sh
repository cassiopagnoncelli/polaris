#!/usr/bin/env bash
#
# Polaris PostgreSQL snapshot script.
#
# Takes a `pg_dump --format=custom` snapshot of the Polaris control-plane
# database and rotates artifacts older than the configured retention
# window. Idempotent and safe to run from cron.
#
# Reference: docs/operations/backup-and-retention.md, "PostgreSQL / Daily snapshot".
#
# Environment variables (all optional; sensible production defaults):
#
#   POLARIS_BACKUP_DIR              default /var/lib/polaris/backups/postgres
#   POLARIS_BACKUP_RETENTION_DAYS   default 14
#   PGHOST                          default localhost
#   PGPORT                          default 5432
#   PGUSER                          default polaris
#   PGDATABASE                      default polaris
#   PGPASSWORD / PGPASSFILE         standard libpq mechanisms; pgpass file preferred
#
# The script intentionally does NOT push to object storage. Operators wrap
# this script in their cron entry with their preferred upload tool
# (`aws s3 cp`, `gcloud storage cp`, `mc cp`, `rclone copy`, ...). Keeping
# the upload step out of the script keeps the dump itself dependency-free.
#
# Exit codes:
#   0  dump + rotation succeeded
#   1  pg_dump failed (file removed if partial)
#   2  configuration error (missing tool, unwritable backup dir)

set -euo pipefail

# --- Config ----------------------------------------------------------------

BACKUP_DIR="${POLARIS_BACKUP_DIR:-/var/lib/polaris/backups/postgres}"
RETENTION_DAYS="${POLARIS_BACKUP_RETENTION_DAYS:-14}"

# libpq defaults if the operator did not set them.
export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-polaris}"
export PGDATABASE="${PGDATABASE:-polaris}"

# --- Tooling check ---------------------------------------------------------

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "[pg-dump] error: pg_dump not found on PATH" >&2
  exit 2
fi

# --- Backup directory ------------------------------------------------------

if ! mkdir -p "${BACKUP_DIR}"; then
  echo "[pg-dump] error: cannot create backup dir ${BACKUP_DIR}" >&2
  exit 2
fi

if [ ! -w "${BACKUP_DIR}" ]; then
  echo "[pg-dump] error: backup dir ${BACKUP_DIR} is not writable" >&2
  exit 2
fi

# --- Dump ------------------------------------------------------------------

# UTC timestamp matching the runbook convention (lexicographic == chronological).
TIMESTAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
DUMP_FILE="${BACKUP_DIR}/polaris-${TIMESTAMP}.dump"
DUMP_TMP="${DUMP_FILE}.partial"

echo "[pg-dump] $(date -u -Iseconds) start ${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE} -> ${DUMP_FILE}"

# --format=custom    parallel-restore-friendly, allows --jobs on restore.
# --no-owner         restored objects belong to the connecting role, not the source owner.
# --no-acl           skips GRANT / REVOKE, so the dump replays cleanly into any database.
# --compress=zstd:3  zstd compression at moderate level; falls back to gzip on older
#                    pg_dump (handled below).
DUMP_CMD=(pg_dump --format=custom --no-owner --no-acl --file "${DUMP_TMP}")

# zstd compression is supported from pg_dump 16+. Fall back to default
# (gzip) on older clients so the script works against managed services
# that pin to older pg_dump binaries.
if pg_dump --help 2>&1 | grep -q -- '--compress=method'; then
  DUMP_CMD+=(--compress=zstd:3)
fi

if ! "${DUMP_CMD[@]}"; then
  echo "[pg-dump] error: pg_dump failed; removing partial file" >&2
  rm -f "${DUMP_TMP}"
  exit 1
fi

# Atomic rename so concurrent readers never see a partial dump.
mv "${DUMP_TMP}" "${DUMP_FILE}"

DUMP_SIZE="$(stat -c %s "${DUMP_FILE}" 2>/dev/null || stat -f %z "${DUMP_FILE}")"
echo "[pg-dump] $(date -u -Iseconds) wrote ${DUMP_FILE} (${DUMP_SIZE} bytes)"

# --- Rotation --------------------------------------------------------------

# Delete *.dump artifacts older than RETENTION_DAYS. -mtime is GNU/BSD-portable.
# Partial files (*.dump.partial) are also cleaned in case of an earlier crash.
echo "[pg-dump] $(date -u -Iseconds) rotating files older than ${RETENTION_DAYS} days"
find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'polaris-*.dump' -mtime "+${RETENTION_DAYS}" -print -delete || true
find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'polaris-*.dump.partial' -mtime +1 -print -delete || true

echo "[pg-dump] $(date -u -Iseconds) done"
