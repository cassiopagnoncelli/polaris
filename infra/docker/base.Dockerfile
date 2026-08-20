# syntax=docker/dockerfile:1.6
#
# Polaris service base Dockerfile (canonical template, reference only).
#
# This file is the authoritative shape for every per-service Dockerfile in
# the repository (apps/*/Dockerfile, processors/*/v*/Dockerfile,
# consumers/*/v*/Dockerfile). Per-service Dockerfiles are intentionally
# duplicated rather than chained via `FROM` so that:
#
#   - Each image has a single, self-contained build description.
#   - There is no implicit base-image dependency that ties unrelated services
#     to the same rebuild cadence.
#   - The "boring and explicit" rule from
#     docs/architecture/09-engineering-standards.md is honored.
#
# This template is reference material — Docker is not asked to build it.
# When the shape changes (base image bump, install pattern, healthcheck
# convention), every per-service Dockerfile must be updated in the same
# commit. Drift between this template and the per-service files is the main
# risk the duplication trades for; `infra/docker/README.md` documents the
# contract that keeps them aligned.
#
# Build context: repository root. The build needs the pnpm workspace
# lockfile and every package.json so workspace dependency graphs resolve.
#
# Build args (all optional, sensible defaults):
#
#   SERVICE_FILTER         pnpm filter selector, e.g. `@polaris/ingester-api`
#   SERVICE_ENTRY          node entrypoint relative to dist/, e.g. `server.js`
#   SERVICE_PORT           HTTP port the runtime listens on (3000 default)
#   POLARIS_BUILD_VERSION  semver-ish build label, surfaced via /health
#   POLARIS_GIT_SHA        commit SHA, surfaced via /health
#   POLARIS_BUILD_TIME     ISO-8601 timestamp, surfaced via /health
#
# Runtime conventions:
#
#   - `node:22-alpine` base, multi-stage build, builder is throwaway.
#   - Non-root user (`polaris`, uid 1001).
#   - WORKDIR /app.
#   - HEALTHCHECK hits `/health` over loopback on `SERVICE_PORT`.
#   - `tini` as PID 1 for clean signal forwarding and zombie reaping.
#   - No secrets baked. Runtime config comes from environment variables.

ARG SERVICE_FILTER="@polaris/EXAMPLE"
ARG SERVICE_ENTRY="server.js"
ARG SERVICE_PORT=3000

# -----------------------------------------------------------------------------
# Stage 1: builder
#
# Installs the entire workspace, compiles the target service, then uses
# `pnpm deploy --prod` to assemble a self-contained production tree under
# /deploy. Workspace `workspace:*` deps are inlined into /deploy/node_modules
# so the runtime stage needs no pnpm and no workspace awareness.
# -----------------------------------------------------------------------------
FROM node:22-alpine AS builder

ARG SERVICE_FILTER
ARG SERVICE_ENTRY

# `libc6-compat` lets prebuilt linux-musl native modules (e.g.
# @node-rs/argon2 used by @polaris/runtime-secrets) load on Alpine.
RUN apk add --no-cache libc6-compat \
    && npm install --global pnpm@10.30.0

WORKDIR /workspace

# Copy the full workspace. The repository's `.dockerignore` prunes
# node_modules, dist, tests, docs, and other non-build inputs so this stays
# tight. A single COPY keeps the Dockerfile portable across older Docker
# versions that lack BuildKit's `--parents` flag.
COPY . .

# Resolve every workspace dependency. `--frozen-lockfile` fails the build
# rather than silently regenerate the lockfile if it has drifted.
RUN pnpm install --frozen-lockfile

# Compile this service and every workspace dep it pulls in.
RUN pnpm --filter "${SERVICE_FILTER}..." run build

# `pnpm deploy --prod` materializes a self-contained production tree under
# /deploy: the target package's dist plus its full production node_modules
# with workspace links replaced by real files.
RUN pnpm --filter "${SERVICE_FILTER}" deploy --prod /deploy

# Fail loudly if the entrypoint did not land where we expect.
RUN test -f "/deploy/dist/${SERVICE_ENTRY}" \
    || (echo "missing /deploy/dist/${SERVICE_ENTRY} — pnpm build did not emit" && exit 1)

# -----------------------------------------------------------------------------
# Stage 2: runtime
#
# Minimal node:22-alpine image with the prepared /deploy tree and a
# non-root user. No pnpm, no TypeScript, no test tooling.
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runtime

ARG SERVICE_PORT
ARG POLARIS_BUILD_VERSION="0.0.0-dev"
ARG POLARIS_GIT_SHA="unknown"
ARG POLARIS_BUILD_TIME="1970-01-01T00:00:00Z"

# OCI labels surface build metadata to image registries and `docker inspect`.
LABEL org.opencontainers.image.title="polaris-service-template" \
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

USER polaris

ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps" \
    POLARIS_BUILD_VERSION="${POLARIS_BUILD_VERSION}" \
    POLARIS_GIT_SHA="${POLARIS_GIT_SHA}" \
    POLARIS_BUILD_TIME="${POLARIS_BUILD_TIME}" \
    POLARIS_HTTP_HOST=0.0.0.0 \
    POLARIS_HTTP_PORT="${SERVICE_PORT}"

EXPOSE ${SERVICE_PORT}

# Healthcheck contract: `/health` is the shared bootstrap's liveness route
# (libs/runtime/service-bootstrap/src/bootstrap/health.ts). It is always
# 200 once the process is up, so a non-200 from this probe is a hard signal
# the runtime crashed or wedged. Use `/ready` (separate route) for
# dependency readiness; we do not wire it into HEALTHCHECK because failing
# readiness should not restart the container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${POLARIS_HTTP_PORT}/health" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
