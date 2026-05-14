# Polaris Docker build-args contract

This file is the authoritative reference for the build args accepted by
every per-service Dockerfile in the repository. The shape is intentionally
small: three args, all optional, all metadata. Secrets and runtime config
never enter via build args.

## The three args

| Arg                     | Default               | Surfaces in                                                                  |
| ----------------------- | --------------------- | ---------------------------------------------------------------------------- |
| `POLARIS_BUILD_VERSION` | `0.0.0-dev`           | runtime `ENV`, OCI `org.opencontainers.image.version`, `/health.version`     |
| `POLARIS_GIT_SHA`       | `unknown`             | runtime `ENV`, OCI `org.opencontainers.image.revision`, `/health.git_sha`    |
| `POLARIS_BUILD_TIME`    | `1970-01-01T00:00:00Z` | runtime `ENV`, OCI `org.opencontainers.image.created`, `/health.build_time` |

Every value flows through three surfaces so an operator inspecting an image
in production has the same metadata visible at the OCI layer
(`docker inspect`), the OS-process layer (the running container's
environment), and the HTTP layer (`GET /health`).

## Rules

- Build args MUST NOT be used to pass secrets. They are embedded in image
  metadata and visible to anyone with `docker inspect` access.
- Build args MUST NOT change runtime behaviour beyond metadata. Service
  configuration belongs in environment variables read by
  `@polaris/shared-config`, applied at container start.
- Default values for all three args are present so `docker build` without
  any `--build-arg` flags succeeds; the resulting image identifies itself
  as `0.0.0-dev` with `unknown` revision. This keeps developer ergonomics
  unchanged while production builds always set explicit values.

## Suggested resolution

```bash
docker build -f apps/ingester-api/Dockerfile \
  --build-arg POLARIS_BUILD_VERSION="$(git describe --tags --always --dirty)" \
  --build-arg POLARIS_GIT_SHA="$(git rev-parse HEAD)" \
  --build-arg POLARIS_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -t polaris/ingester-api:"$(git describe --tags --always)" .
```

The repository ships `scripts/docker-build.mjs` (and `pnpm docker:build`)
which performs the same resolution automatically for every service.

## Verification

```bash
docker inspect polaris/ingester-api:dev \
  --format '{{json .Config.Labels}}' \
  | jq '{version: ."org.opencontainers.image.version", revision: ."org.opencontainers.image.revision", created: ."org.opencontainers.image.created"}'

docker run --rm -d -p 4000:4000 polaris/ingester-api:dev
curl -s http://127.0.0.1:4000/health | jq '{version, git_sha, build_time}'
```

Both surfaces must agree. A mismatch means someone bypassed the build
script and rebuilt only one layer.
