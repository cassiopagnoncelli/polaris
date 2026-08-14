#!/usr/bin/env bash
#
# Polaris GeoLite2 database refresh.
#
# Downloads the MaxMind GeoLite2-City database, verifies it, and swaps it
# into place atomically for the enrichment stage
# (`sync/enrichment/runtime/v1`, `POLARIS_SYNC_ENRICHMENT_GEOIP_DB_PATH`).
# Idempotent and safe to run from cron.
#
# Reference: docs/implementation/pipeline-redesign-plan.md §2.3.
#
# ## Why this is a script and not a container layer
#
# The database is license-restricted, so it cannot be committed or baked
# into an image we push. It is also ~60 MB and changes weekly, which
# would make it the largest and most frequently invalidated layer of an
# image whose code changes far less often. It is an operational artifact
# with its own lifecycle: fetched here, mounted there.
#
# ## Why the swap is atomic
#
# The stage reads the file ONCE, at boot, into memory. A half-written
# file at that moment is the one failure this script can cause, and
# `mv` within a filesystem is atomic — so a booting process sees either
# the old database or the new one, never a truncated download. The
# running process is unaffected either way; it keeps the snapshot it
# loaded until it restarts, which is what makes the `source` stamped on
# its output honest for the life of the process.
#
# ## Environment variables
#
#   POLARIS_GEOIP_LICENSE_KEY   required        MaxMind licence key
#   POLARIS_GEOIP_EDITION       GeoLite2-City   edition id to fetch
#   POLARIS_GEOIP_DB_PATH       required        destination .mmdb path
#   POLARIS_GEOIP_KEEP_PREVIOUS 1               keep one .previous copy
#
# Get a licence key free at https://www.maxmind.com/en/geolite2/signup —
# the account is required by the licence even though the data is free.

set -Eeuo pipefail

readonly EDITION="${POLARIS_GEOIP_EDITION:-GeoLite2-City}"
readonly DB_PATH="${POLARIS_GEOIP_DB_PATH:-}"
readonly LICENSE_KEY="${POLARIS_GEOIP_LICENSE_KEY:-}"
readonly KEEP_PREVIOUS="${POLARIS_GEOIP_KEEP_PREVIOUS:-1}"

log() { printf '%s refresh-geoip: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

[ -n "$DB_PATH" ] || die "POLARIS_GEOIP_DB_PATH is required"
[ -n "$LICENSE_KEY" ] || die "POLARIS_GEOIP_LICENSE_KEY is required"
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar >/dev/null 2>&1 || die "tar is required"

readonly DEST_DIR="$(dirname "$DB_PATH")"
mkdir -p "$DEST_DIR"

readonly WORK_DIR="$(mktemp -d)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

readonly URL="https://download.maxmind.com/app/geoip_download?edition_id=${EDITION}&license_key=${LICENSE_KEY}&suffix=tar.gz"

log "fetching ${EDITION}"
# --fail turns an HTTP error into a non-zero exit instead of saving the
# error page as if it were a database. That failure mode is exactly what
# `openMaxmindLookup` reports as "not a readable mmdb database", and it
# is better caught here.
curl --fail --silent --show-error --location --retry 3 --retry-delay 5 \
  --output "${WORK_DIR}/db.tar.gz" "$URL" \
  || die "download failed (check the licence key and the edition id)"

log "extracting"
tar -xzf "${WORK_DIR}/db.tar.gz" -C "$WORK_DIR"

# The archive expands to <edition>_<YYYYMMDD>/<edition>.mmdb; the dated
# directory is why this globs rather than naming a path.
FOUND="$(find "$WORK_DIR" -name "${EDITION}.mmdb" -type f | head -n 1)"
[ -n "$FOUND" ] || die "no ${EDITION}.mmdb inside the archive"

# Sanity-check the magic marker before swapping. A file that is not a
# database would boot the stage into permanent fail-open, which is a
# quiet failure — much better to refuse the swap and keep yesterday's.
if ! tail -c 200000 "$FOUND" | grep -qa "$(printf '\xab\xcd\xefMaxMind.com')"; then
  die "downloaded file does not carry the MaxMind metadata marker"
fi

readonly SIZE="$(wc -c < "$FOUND" | tr -d ' ')"
[ "$SIZE" -gt 1000000 ] || die "downloaded database is implausibly small (${SIZE} bytes)"

if [ "$KEEP_PREVIOUS" = "1" ] && [ -f "$DB_PATH" ]; then
  cp -p "$DB_PATH" "${DB_PATH}.previous"
fi

# Same filesystem, so this is atomic: a booting process sees the old
# database or the new one, never a partial file.
mv "$FOUND" "${DB_PATH}.incoming"
mv "${DB_PATH}.incoming" "$DB_PATH"

log "installed ${EDITION} at ${DB_PATH} (${SIZE} bytes)"
log "note: running processes keep the snapshot they booted with; restart to pick this up"
