# syntax=docker/dockerfile:1.6
#
# Polaris ingester-api production image.
#
# Built from the repository root so the pnpm workspace lockfile and every
# package.json are visible to the install step. See
# `infra/docker/base.Dockerfile` for the canonical template and
# `infra/docker/README.md` for the build-arg contract and image map.
#
# Build:
#   docker build -f apps/ingester-api/Dockerfile \
#     --build-arg POLARIS_BUILD_VERSION=$(git describe --tags --always) \
#     --build-arg POLARIS_GIT_SHA=$(git rev-parse HEAD) \
#     --build-arg POLARIS_BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
#     -t polaris/ingester-api:dev .

# -----------------------------------------------------------------------------
# Stage 1: builder
# -----------------------------------------------------------------------------
FROM node:22-alpine AS builder

# `libc6-compat` lets prebuilt linux-musl native modules (e.g.
# @node-rs/argon2 used by @polaris/shared-secrets) load on Alpine.
RUN apk add --no-cache libc6-compat \
    && npm install --global pnpm@10.30.0

WORKDIR /workspace

# Copy the full workspace. The repository's .dockerignore prunes
# node_modules, dist, tests, docs, and other non-build inputs so this stays
# tight. We accept full-source invalidation on any code change in exchange
# for a single, portable COPY that does not depend on BuildKit's `--parents`
# flag (Docker 25 / BuildKit 1.7+).
COPY . .

# Resolve every workspace dependency. `--frozen-lockfile` fails the build
# rather than silently regenerate the lockfile if it has drifted.
RUN pnpm install --frozen-lockfile

# Compile this service and every workspace dep it pulls in.
RUN pnpm --filter "@polaris/ingester-api..." run build

# `pnpm deploy --prod` materializes a self-contained production tree under
# /deploy: the target package's source/dist plus its full production
# node_modules with workspace links replaced by real files. The runtime
# stage needs no pnpm and no workspace awareness after this.
RUN pnpm --filter "@polaris/ingester-api" deploy --prod /deploy

# Fail loudly if the entrypoint did not land where we expect.
RUN test -f /deploy/dist/server.js \
    || (echo "missing /deploy/dist/server.js — pnpm build did not emit" && exit 1)

# -----------------------------------------------------------------------------
# Stage 2: runtime
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runtime

ARG POLARIS_BUILD_VERSION="0.0.0-dev"
ARG POLARIS_GIT_SHA="unknown"
ARG POLARIS_BUILD_TIME="1970-01-01T00:00:00Z"

LABEL org.opencontainers.image.title="polaris-ingester-api" \
      org.opencontainers.image.description="Polaris ingester API service" \
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

# Service runtime config. Secrets are NOT baked here — they arrive via
# environment variables at container start.
ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps" \
    POLARIS_BUILD_VERSION="${POLARIS_BUILD_VERSION}" \
    POLARIS_GIT_SHA="${POLARIS_GIT_SHA}" \
    POLARIS_BUILD_TIME="${POLARIS_BUILD_TIME}" \
    POLARIS_HTTP_HOST=0.0.0.0 \
    POLARIS_HTTP_PORT=4000

EXPOSE 4000

# `/health` is the shared bootstrap's liveness route. 200 means the process
# is alive; readiness (dependency probes) lives at `/ready` and is checked
# separately by Kubernetes readiness probes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${POLARIS_HTTP_PORT}/health" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
