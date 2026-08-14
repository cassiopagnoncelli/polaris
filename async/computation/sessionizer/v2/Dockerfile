# syntax=docker/dockerfile:1.6
#
# Polaris sessionizer v2 processor production image.
#
# Built from the repository root. See `infra/docker/base.Dockerfile` for
# the canonical template and `infra/docker/README.md` for the build-arg
# contract.
#
# Build:
#   docker build -f async/computation/sessionizer/v2/Dockerfile \
#     --build-arg POLARIS_BUILD_VERSION=$(git describe --tags --always) \
#     --build-arg POLARIS_GIT_SHA=$(git rev-parse HEAD) \
#     --build-arg POLARIS_BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
#     -t polaris/processor-sessionizer-v2:dev .

# -----------------------------------------------------------------------------
# Stage 1: builder
# -----------------------------------------------------------------------------
FROM node:22-alpine AS builder

RUN apk add --no-cache libc6-compat \
    && npm install --global pnpm@10.30.0

WORKDIR /workspace

COPY . .

RUN pnpm install --frozen-lockfile

RUN pnpm --filter "@polaris/processor-sessionizer-v2..." run build

RUN pnpm --filter "@polaris/processor-sessionizer-v2" deploy --prod /deploy

RUN test -f /deploy/dist/main.js \
    || (echo "missing /deploy/dist/main.js — pnpm build did not emit" && exit 1)

# -----------------------------------------------------------------------------
# Stage 2: runtime
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runtime

ARG POLARIS_BUILD_VERSION="0.0.0-dev"
ARG POLARIS_GIT_SHA="unknown"
ARG POLARIS_BUILD_TIME="1970-01-01T00:00:00Z"

LABEL org.opencontainers.image.title="polaris-processor-sessionizer-v2" \
      org.opencontainers.image.description="Polaris sessionizer v2: session windows keyed on the person, not on whichever identifier an event carried" \
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
    POLARIS_HTTP_PORT=4017

EXPOSE 4017

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${POLARIS_HTTP_PORT}/health" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
