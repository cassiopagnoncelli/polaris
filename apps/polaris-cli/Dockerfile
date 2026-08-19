# syntax=docker/dockerfile:1.6
#
# Polaris CLI production image.
#
# Unlike the long-running services, the CLI is a one-shot binary: it
# executes a subcommand against a remote control-plane-api over HTTPS and
# exits. The image therefore has no port, no healthcheck, and no Fastify
# server — the entrypoint is the `polaris` bin and the default command is
# `--help`.
#
# Built from the repository root. See `infra/docker/base.Dockerfile` for
# the canonical template and `infra/docker/README.md` for the build-arg
# contract.
#
# Build:
#   docker build -f apps/polaris-cli/Dockerfile \
#     --build-arg POLARIS_BUILD_VERSION=$(git describe --tags --always) \
#     --build-arg POLARIS_GIT_SHA=$(git rev-parse HEAD) \
#     --build-arg POLARIS_BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
#     -t polaris/polaris-cli:dev .
#
# Use:
#   docker run --rm -e POLARIS_CONTROL_PLANE_URL=... \
#     -e POLARIS_CONTROL_PLANE_TOKEN=... \
#     polaris/polaris-cli:dev whoami

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

RUN pnpm --filter "@polaris/polaris-cli..." run build

RUN pnpm --filter "@polaris/polaris-cli" deploy --prod /deploy

RUN test -f /deploy/dist/bin/polaris.js \
    || (echo "missing /deploy/dist/bin/polaris.js — pnpm build did not emit" && exit 1)

# -----------------------------------------------------------------------------
# Stage 2: runtime
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runtime

ARG POLARIS_BUILD_VERSION="0.0.0-dev"
ARG POLARIS_GIT_SHA="unknown"
ARG POLARIS_BUILD_TIME="1970-01-01T00:00:00Z"

LABEL org.opencontainers.image.title="polaris-cli" \
      org.opencontainers.image.description="Polaris control-plane CLI" \
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
    POLARIS_BUILD_TIME="${POLARIS_BUILD_TIME}"

# CLI images need no port, no healthcheck. The CLI talks outbound to
# control-plane-api and exits with the command's status. `tini` keeps PID 1
# clean so signals (Ctrl-C) propagate.
ENTRYPOINT ["/sbin/tini", "--", "node", "dist/bin/polaris.js"]
CMD ["--help"]
