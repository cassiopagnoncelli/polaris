#!/usr/bin/env bash
#
# Polaris ClickHouse backup script.
#
# Wraps the canonical ClickHouse `BACKUP TABLE` statement
#
#   BACKUP TABLE polaris.<table> TO Disk('<disk>', '<table>-<ts>.zip')
#         SETTINGS compression_method = 'zstd', compression_level = 3
#
# against an operator-supplied backup disk. The disk must be declared in
# the ClickHouse server config under
# /etc/clickhouse-server/config.d/backup_disk.xml — see
# docs/operations/backup-and-retention.md, "ClickHouse / Disk configuration"
# for both the local-filesystem (dev/staging) and S3 (production)
# reference configs.
#
# Usage:
#   infra/backups/clickhouse-backup.sh analytics_raw
#   infra/backups/clickhouse-backup.sh analytics_ingest_log
#
# Environment variables (all optional; sensible local/dev defaults):
#
#   CLICKHOUSE_URL          default http://localhost:8123 (HTTP interface)
#   CLICKHOUSE_DATABASE     default polaris
#   CLICKHOUSE_BACKUP_DISK  default backup_disk
#   CLICKHOUSE_USER         default polaris (must have BACKUP privilege)
#   CLICKHOUSE_PASSWORD     default polaris
#   CLICKHOUSE_BACKUP_COMPRESSION_LEVEL  default 3 (zstd)
#
# Auth: the script POSTs to the HTTP interface and authenticates with Basic
# auth. This matches scripts/clickhouse-migrate.mjs so the same CLICKHOUSE_*
# env vars work across both tools.
#
# Exit codes:
#   0  backup statement returned success
#   1  ClickHouse rejected the BACKUP statement (e.g. disk not allowed)
#   2  configuration error (missing tool, missing table arg)

set -euo pipefail

# --- Args / Config ---------------------------------------------------------

if [ "$#" -ne 1 ]; then
  echo "usage: clickhouse-backup.sh <table-name>" >&2
  echo "  examples: analytics_raw | analytics_ingest_log" >&2
  exit 2
fi

TABLE="$1"

URL="${CLICKHOUSE_URL:-http://localhost:8123}"
DATABASE="${CLICKHOUSE_DATABASE:-polaris}"
DISK="${CLICKHOUSE_BACKUP_DISK:-backup_disk}"
USER="${CLICKHOUSE_USER:-polaris}"
PASSWORD="${CLICKHOUSE_PASSWORD:-polaris}"
COMPRESSION_LEVEL="${CLICKHOUSE_BACKUP_COMPRESSION_LEVEL:-3}"

# Strip trailing slash for the same reason scripts/clickhouse-migrate.mjs
# does: makes the URL composition below predictable.
URL="${URL%/}"

# --- Tooling check ---------------------------------------------------------

if ! command -v curl >/dev/null 2>&1; then
  echo "[clickhouse-backup] error: curl not found on PATH" >&2
  exit 2
fi

# --- Backup statement ------------------------------------------------------

# UTC timestamp matching the runbook convention (lexicographic == chronological).
TIMESTAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
ARTIFACT="${TABLE}-${TIMESTAMP}.zip"

# zstd is the recommended compression for ClickHouse backups. Level 3 is a
# good speed/size tradeoff; tune via CLICKHOUSE_BACKUP_COMPRESSION_LEVEL if
# the storage budget is tight or backup latency matters.
read -r -d '' SQL <<SQL_EOF || true
BACKUP TABLE ${DATABASE}.${TABLE}
  TO Disk('${DISK}', '${ARTIFACT}')
  SETTINGS compression_method = 'zstd', compression_level = ${COMPRESSION_LEVEL}
SQL_EOF

echo "[clickhouse-backup] $(date -u -Iseconds) start ${DATABASE}.${TABLE} -> Disk('${DISK}', '${ARTIFACT}')"

# Use the HTTP /query endpoint. ClickHouse responds 200 on success with the
# BACKUP's result row (id + status); 4xx/5xx on failure with the engine
# error text in the body.
RESPONSE_FILE="$(mktemp)"
trap 'rm -f "${RESPONSE_FILE}"' EXIT

HTTP_CODE="$(curl \
  --silent \
  --show-error \
  --output "${RESPONSE_FILE}" \
  --write-out '%{http_code}' \
  --user "${USER}:${PASSWORD}" \
  --header 'Content-Type: text/plain; charset=utf-8' \
  --data-binary "${SQL}" \
  "${URL}/")"

if [ "${HTTP_CODE}" != "200" ]; then
  echo "[clickhouse-backup] error: ClickHouse responded ${HTTP_CODE}" >&2
  echo "--- response body ---" >&2
  cat "${RESPONSE_FILE}" >&2
  echo "--- end response body ---" >&2
  exit 1
fi

echo "[clickhouse-backup] $(date -u -Iseconds) ${DATABASE}.${TABLE} backed up to Disk('${DISK}', '${ARTIFACT}')"
echo "--- clickhouse response ---"
cat "${RESPONSE_FILE}"
echo "--- end response ---"
