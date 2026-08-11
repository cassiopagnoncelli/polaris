#!/usr/bin/env bash
# Compare packages/polaris-idp's vendored files against an upstream idp-js
# checkout, normalising both sides through Biome first.
#
# The vendored copies are upstream's source with Polaris's formatting applied
# (see packages/polaris-idp/README.md "Keeping in sync"), so a raw `diff`
# reports line-wrapping noise. This normalises both sides and reports only
# real changes.
#
# Usage:
#   scripts/idp-vendor-diff.sh [path-to-idp-js]     # default ~/src/idp-js
#
# Exits 0 and prints nothing when the vendored copies match upstream.
# Exits 1 and prints a unified diff when they do not.
#
# `jwks-client.ts` and `verifier.ts` are deliberately adapted (explicit config
# object, structural RevocationChecker) and are NOT compared here — review
# those two by hand on an upgrade.

set -euo pipefail

UPSTREAM="${1:-$HOME/src/idp-js}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$REPO_ROOT/packages/polaris-idp/src"

# Files taken verbatim from upstream (modulo formatting).
FILES=(errors.ts passport.ts refresh-client.ts)

if [ ! -d "$UPSTREAM/src" ]; then
  echo "idp-js checkout not found at $UPSTREAM" >&2
  echo "usage: scripts/idp-vendor-diff.sh [path-to-idp-js]" >&2
  exit 2
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for f in "${FILES[@]}"; do
  if [ ! -f "$UPSTREAM/src/$f" ]; then
    echo "missing upstream file: $UPSTREAM/src/$f" >&2
    exit 2
  fi
  cp "$UPSTREAM/src/$f" "$TMP/$f"
done

# Normalise upstream through the same formatter the vendored copies went through.
(cd "$REPO_ROOT" && npx biome format --write "$TMP" >/dev/null 2>&1)

status=0
for f in "${FILES[@]}"; do
  if ! diff -u --label "upstream/$f" --label "vendored/$f" "$TMP/$f" "$VENDOR/$f"; then
    status=1
  fi
done

exit "$status"
