#!/usr/bin/env bash
#
# Polaris PostgreSQL restore script.
#
# Wraps `pg_restore` for the canonical recovery / drill path. Designed
# to restore a dump produced by infra/backups/pg-dump.sh into a target
# database that is NOT the production primary.
#
# Reference: docs/operations/backup-and-retention.md, "PostgreSQL / Restore drill".
#
# Usage:
#   POLARIS_RESTORE_DATABASE=polaris_restore \
#     infra/backups/pg-restore.sh /var/lib/polaris/backups/postgres/polaris-20260512T020000Z.dump
#
# Environment variables (all optional except POLARIS_RESTORE_DATABASE):
#
#   POLARIS_RESTORE_DATABASE   required; target database name
#   POLARIS_RESTORE_JOBS       default 4; parallel restore workers
#   POLARIS_RESTORE_FORCE      default 0; bypass the primary-safety check (NOT recommended)
#   PGHOST                     default localhost
#   PGPORT                     default 5432
#   PGUSER                     default polaris
#   PGPASSWORD / PGPASSFILE    standard libpq mechanisms
#
# Safety:
#   The script aborts if the target database has active connections from an
#   application named "polaris-control-plane". The check is a courtesy, not
#   a security boundary; production safety lives at the deployment-permission
#   layer.
#
# Exit codes:
#   0  restore succeeded
#   1  pg_restore failed
#   2  configuration error (missing dump, missing target, primary safety tripped)

set -euo pipefail

# --- Args / Config ---------------------------------------------------------

if [ "$#" -ne 1 ]; then
  echo "usage: pg-restore.sh <dump-file>" >&2
  echo "  Set POLARIS_RESTORE_DATABASE before invoking." >&2
  exit 2
fi

DUMP_FILE="$1"
TARGET_DB="${POLARIS_RESTORE_DATABASE:-}"
JOBS="${POLARIS_RESTORE_JOBS:-4}"
FORCE="${POLARIS_RESTORE_FORCE:-0}"

export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-polaris}"

if [ -z "${TARGET_DB}" ]; then
  echo "[pg-restore] error: POLARIS_RESTORE_DATABASE is required" >&2
  exit 2
fi

if [ ! -f "${DUMP_FILE}" ]; then
  echo "[pg-restore] error: dump file not found: ${DUMP_FILE}" >&2
  exit 2
fi

if ! command -v pg_restore >/dev/null 2>&1; then
  echo "[pg-restore] error: pg_restore not found on PATH" >&2
  exit 2
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "[pg-restore] error: psql not found on PATH" >&2
  exit 2
fi

# --- Primary-safety check --------------------------------------------------

if [ "${FORCE}" != "1" ]; then
  # Count active backends in the target database that identify themselves as
  # the Polaris control plane. The control plane is expected to set
  # `application_name=polaris-control-plane` in its connection options (see
  # apps/control-plane-api). Any hit here means we are about to restore over
  # an active primary, which is almost never what the operator wants.
  ACTIVE_PRIMARY="$(psql -tA -d "${TARGET_DB}" -c \
    "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'polaris-control-plane';" \
    2>/dev/null || echo "0")"

  if [ "${ACTIVE_PRIMARY}" -gt 0 ]; then
    echo "[pg-restore] error: target database '${TARGET_DB}' has ${ACTIVE_PRIMARY} active polaris-control-plane connection(s)." >&2
    echo "[pg-restore] this looks like a Polaris primary. Set POLARIS_RESTORE_FORCE=1 to override (NOT recommended)." >&2
    exit 2
  fi
fi

# --- Restore ---------------------------------------------------------------

echo "[pg-restore] $(date -u -Iseconds) start ${DUMP_FILE} -> ${PGUSER}@${PGHOST}:${PGPORT}/${TARGET_DB} (jobs=${JOBS})"

# --no-owner       restored objects belong to the connecting role.
# --no-acl         skip GRANT / REVOKE.
# --clean          drop existing objects before recreating (idempotent re-runs).
# --if-exists      avoid DROP errors on a fresh target.
# --jobs           parallel workers; safe for custom-format dumps.
# -d <db>          connect directly to the target database.
pg_restore \
  --no-owner \
  --no-acl \
  --clean \
  --if-exists \
  --jobs="${JOBS}" \
  -d "${TARGET_DB}" \
  "${DUMP_FILE}"

echo "[pg-restore] $(date -u -Iseconds) done"
