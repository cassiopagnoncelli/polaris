# syntax=docker/dockerfile:1.6
#
# Polaris enrichment stage (sync/enrichment/runtime v1) production image.
#
# Built from the repository root. See `infra/docker/base.Dockerfile` for
# the canonical template and `infra/docker/README.md` for the build-arg
# contract.
#
# Build:
#   docker build -f sync/enrichment/runtime/v1/Dockerfile \
#     --build-arg POLARIS_BUILD_VERSION=$(git describe --tags --always) \
#     --build-arg POLARIS_GIT_SHA=$(git rev-parse HEAD) \
#     --build-arg POLARIS_BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
#     -t polaris/sync-enrichment-runtime-v1:dev .

# -----------------------------------------------------------------------------
# Stage 1: builder
# -----------------------------------------------------------------------------
FROM node:22-alpine AS builder

RUN apk add --no-cache libc6-compat \
    # No version: pnpm reads `packageManager` from the root package.json and
    # self-manages to it. Pinning here made a THIRD copy of that version --
    # the workflow's copy going stale is what killed CI for seven days, and
    # this one was already a major behind, silently downloading pnpm twice
    # on every image build.
    && npm install --global pnpm

WORKDIR /workspace

COPY . .

RUN pnpm install --frozen-lockfile

RUN pnpm --filter "@polaris/sync-enrichment-runtime-v1..." run build

RUN pnpm --filter "@polaris/sync-enrichment-runtime-v1" deploy --prod /deploy

RUN test -f /deploy/dist/main.js \
    || (echo "missing /deploy/dist/main.js — pnpm build did not emit" && exit 1)

# -----------------------------------------------------------------------------
# Stage 2: runtime
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runtime

ARG POLARIS_BUILD_VERSION="0.0.0-dev"
ARG POLARIS_GIT_SHA="unknown"
ARG POLARIS_BUILD_TIME="1970-01-01T00:00:00Z"

LABEL org.opencontainers.image.title="polaris-sync-enrichment-runtime-v1" \
      org.opencontainers.image.description="Polaris enrichment stage (stage 3): traits snapshot + geo" \
      org.opencontainers.image.vendor="Polaris" \
      org.opencontainers.image.licenses="UNLICENSED" \
      org.opencontainers.image.version="${POLARIS_BUILD_VERSION}" \
      org.opencontainers.image.revision="${POLARIS_GIT_SHA}" \
      org.opencontainers.image.created="${POLARIS_BUILD_TIME}"

RUN apk add --no-cache libc6-compat tini \
    && addgroup -S -g 1001 polaris \
    && adduser -S -G polaris -u 1001 polaris

WORKDIR /app

COPY --from=builder --chown=polaris:polaris /deploy /app

# Per-project enrichment overrides (`enrichment:` blocks — the narrowed
# traits-snapshot guard) are read from here at boot; see src/overrides.ts.
# `POLARIS_SYNC_ENRICHMENT_CATALOG_ROOT` defaults to ".", i.e. /app.
COPY --from=builder --chown=polaris:polaris /workspace/definitions/projects /app/definitions/projects

# The MaxMind database is deliberately NOT baked into the image: it is
# license-restricted, ~60 MB, and refreshed on its own cadence by
# infra/geoip/refresh-geoip.sh. It is an operational artifact with a
# lifecycle of its own — fetched on the host, mounted here.
#
# THE MOUNT CONTRACT. The stage reads exactly one path, named by
# POLARIS_SYNC_ENRICHMENT_GEOIP_DB_PATH. /etc/polaris/geoip is the
# directory this image expects it under, and is what `.env.example` and
# the deployment docs use:
#
#   docker run \
#     -v /srv/polaris/geoip:/etc/polaris/geoip:ro \
#     -e POLARIS_SYNC_ENRICHMENT_GEOIP_DB_PATH=/etc/polaris/geoip/GeoLite2-City.mmdb \
#     polaris/sync-enrichment-runtime-v1:dev
#
# Mount the DIRECTORY, not the file. The refresh swaps a new database in
# with `mv`, which replaces the inode — a bind mount of the file itself
# would pin the container to the inode that existed when it started, so
# the container would keep reading the superseded database and nothing
# would say so. That is the same reason the mount is read-only: nothing
# in this image ever writes there.
#
# The directory is created by the mount, so no RUN mkdir here; declaring
# it as a VOLUME would be worse than nothing, since it would give a
# container started WITHOUT the mount an empty anonymous volume instead
# of the plain absence the stage reports at boot.
#
# Absent, the stage runs fail-open: one warning at boot naming the path
# it tried, `polaris_enrichment_geoip_database_loaded 0` on /metrics, and
# every geo block reading `source: "no_lookup"`.
#
# See docs/operations/runbook-geoip-refresh.md.

USER polaris

ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps" \
    POLARIS_BUILD_VERSION="${POLARIS_BUILD_VERSION}" \
    POLARIS_GIT_SHA="${POLARIS_GIT_SHA}" \
    POLARIS_BUILD_TIME="${POLARIS_BUILD_TIME}" \
    POLARIS_HTTP_HOST=0.0.0.0 \
    POLARIS_HTTP_PORT=4015

EXPOSE 4015

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${POLARIS_HTTP_PORT}/health" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
