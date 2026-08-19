# syntax=docker/dockerfile:1.6
#
# Polaris tiktok v1 consumer production image.
#
# Built from the repository root. See `infra/docker/base.Dockerfile` for
# the canonical template and `infra/docker/README.md` for the build-arg
# contract.
#
# Build:
#   docker build -f sync/destinations/tiktok/v1/Dockerfile \
#     --build-arg POLARIS_BUILD_VERSION=$(git describe --tags --always) \
#     --build-arg POLARIS_GIT_SHA=$(git rev-parse HEAD) \
#     --build-arg POLARIS_BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
#     -t polaris/consumer-tiktok-v1:dev .

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

RUN pnpm --filter "@polaris/consumer-tiktok-v1..." run build

RUN pnpm --filter "@polaris/consumer-tiktok-v1" deploy --prod /deploy

RUN test -f /deploy/dist/main.js \
    || (echo "missing /deploy/dist/main.js — pnpm build did not emit" && exit 1)

# -----------------------------------------------------------------------------
# Stage 2: runtime
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runtime

ARG POLARIS_BUILD_VERSION="0.0.0-dev"
ARG POLARIS_GIT_SHA="unknown"
ARG POLARIS_BUILD_TIME="1970-01-01T00:00:00Z"

LABEL org.opencontainers.image.title="polaris-consumer-tiktok-v1" \
      org.opencontainers.image.description="Polaris TikTok Events API consumer v1" \
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
    POLARIS_HTTP_PORT=5003

EXPOSE 5003

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${POLARIS_HTTP_PORT}/health" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
