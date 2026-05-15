# Polaris Docker images

This directory holds the canonical Dockerfile template and the documentation
that ties the per-service Dockerfiles together. The actual build files live
next to each service:

| Service                                  | Dockerfile                                            | Image                                            | Port |
| ---------------------------------------- | ----------------------------------------------------- | ------------------------------------------------ | ---- |
| `ingester-api`                           | `apps/ingester-api/Dockerfile`                        | `polaris/ingester-api`                           | 4000 |
| `control-plane-api`                      | `apps/control-plane-api/Dockerfile`                   | `polaris/control-plane-api`                      | 4001 |
| `polaris-cli`                            | `apps/polaris-cli/Dockerfile`                         | `polaris/polaris-cli`                            | —    |
| `analytics-projector v1`                 | `processors/analytics-projector/v1/Dockerfile`        | `polaris/processor-analytics-projector-v1`       | 4010 |
| `identity-resolver v1`                   | `processors/identity-resolver/v1/Dockerfile`          | `polaris/processor-identity-resolver-v1`         | 4011 |
| `sessionizer v1`                         | `processors/sessionizer/v1/Dockerfile`                | `polaris/processor-sessionizer-v1`               | 4012 |
| `geoip-enricher v1`                      | `processors/geoip-enricher/v1/Dockerfile`             | `polaris/processor-geoip-enricher-v1`            | 4013 |
| `attribution-engine v1`                  | `processors/attribution-engine/v1/Dockerfile`         | `polaris/processor-attribution-engine-v1`        | 4014 |
| `webhook-sink v1`                        | `consumers/webhook-sink/v1/Dockerfile`                | `polaris/consumer-webhook-sink-v1`               | 5000 |
| `meta-capi v1`                           | `consumers/meta-capi/v1/Dockerfile`                   | `polaris/consumer-meta-capi-v1`                  | 5001 |
| `tiktok v1`                              | `consumers/tiktok/v1/Dockerfile`                      | `polaris/consumer-tiktok-v1`                     | 5003 |
| `ga4 v1`                                 | `consumers/ga4/v1/Dockerfile`                         | `polaris/consumer-ga4-v1`                        | 5002 |
| `braze v1`                               | `consumers/braze/v1/Dockerfile`                       | `polaris/consumer-braze-v1`                      | 5004 |

The polaris-cli image is a CLI bin, not a long-running server — it has no
exposed port and no `HEALTHCHECK`.

## Architectural decisions

### Per-service Dockerfiles, not a chained base image

Each service ships a complete, standalone Dockerfile. `infra/docker/base.Dockerfile`
is a **reference template**, not a build input. Docker does not build it.

This trades a small amount of duplication for two properties the platform
cares about more:

- **Independent rebuild cadence.** A processor can rev its base node version,
  add a native dep, or change its entrypoint without forcing every other
  service to rebuild.
- **One file is the whole truth.** Reading `apps/ingester-api/Dockerfile`
  tells you the entire story of how that image is built. No upstream
  layered image to look up.

The drift risk is real. The mitigations are:

- The shapes are mechanical (same stages, same labels, same healthcheck).
- `infra/docker/base.Dockerfile` is the canonical reference; any structural
  change goes there first and propagates to per-service files in the same
  commit.
- `scripts/docker-build.mjs` knows the full inventory, so CI can sweep all
  images in one command.

### `node:22-alpine` base image

Alpine wins for image size (~50 MB final layer compared to ~140 MB for
`bookworm-slim`) and matches the platform's "boring and explicit" rule.

The known native-deps risk is `@node-rs/argon2` (used by
`@polaris/shared-secrets`). It ships prebuilt `linux-musl-x64-gnu` and
`linux-musl-arm64-gnu` binaries, so Alpine works without rebuilding from
source. `libc6-compat` is installed in both the builder and runtime stages
to keep glibc-targeted prebuilts compatible if they ever appear.

If a future dep forces glibc, the migration to `node:22-bookworm-slim` is
mechanical: swap the two `FROM node:22-alpine` lines and replace `apk add`
with `apt-get install`.

### Multi-stage build with `pnpm deploy --prod`

The builder stage installs the entire pnpm workspace, compiles the target
service (and every workspace dep via project references), then materializes
a self-contained production tree under `/deploy` using `pnpm deploy --prod`.

The runtime stage copies `/deploy` and runs `node dist/main.js`
(processors / consumers) or `node dist/server.js` (apps/ingester-api,
control-plane-api). No pnpm, no TypeScript, no devDependencies.

`pnpm deploy` replaces every `workspace:*` link with concrete files, so the
runtime image needs no workspace awareness and no shared `node_modules`
directory shared across services.

### Non-root user, `tini` as PID 1

Every image creates `polaris` (uid 1001, gid 1001) and runs as that user.
`tini` is the entrypoint, which:

- forwards POSIX signals (`SIGTERM`, `SIGINT`) to the Node process so
  graceful shutdown handlers in `@polaris/shared-service-bootstrap` fire.
- reaps zombie children if the service ever shells out (it does not today;
  defensive insurance).

### Healthcheck contract

`HEALTHCHECK` is installed on every long-running service and hits
`http://127.0.0.1:${POLARIS_HTTP_PORT}/health` over loopback. `/health` is
the shared bootstrap's liveness route (see
`packages/shared-service-bootstrap/src/bootstrap/health.ts`). It returns
200 as long as the process is up, including build metadata
(`service`, `version`, `git_sha`, `build_time`, `environment`).

`/ready` is **not** wired into `HEALTHCHECK` by design — failing readiness
because Postgres is down should not restart the container; Kubernetes
readiness probes consume `/ready` separately to drop the pod from a
service's endpoints list.

The CLI image has no healthcheck (one-shot binary).

## Build args contract

Every Dockerfile accepts three build args. All three are optional with
sensible fallbacks, but production builds should set all three so `/health`
reports accurate metadata.

| Build arg                | Purpose                                                  | Suggested source                  |
| ------------------------ | -------------------------------------------------------- | --------------------------------- |
| `POLARIS_BUILD_VERSION`  | Human-readable build label (semver-ish).                 | `git describe --tags --always`    |
| `POLARIS_GIT_SHA`        | Commit SHA of the source tree the image was built from.  | `git rev-parse HEAD`              |
| `POLARIS_BUILD_TIME`     | ISO-8601 UTC timestamp of the build.                     | `date -u +%Y-%m-%dT%H:%M:%SZ`     |

These flow through to:

- `ENV` lines on the runtime image (visible to the running process).
- `org.opencontainers.image.version` / `.revision` / `.created` OCI labels
  (visible to `docker inspect` and image registries).
- The `/health` JSON response (visible to monitoring and humans).

Build args MUST NOT be used to pass secrets. They land in the image
metadata and are visible to anyone who can `docker inspect` the image.

### Release label (runtime-only)

`POLARIS_RELEASE_LABEL` is the optional human-readable pipeline release
tag (e.g. `2026-q2-r1`). It is **not** a build arg — it is set at
container start so the same image can run under different release labels
across rollouts. The shared service bootstrap surfaces it on
`/health.release_label` and as a binding on every log line. See
`docs/deployment/versioning.md` for the hybrid-versioning model.

## Building a single service

```bash
docker build -f apps/ingester-api/Dockerfile \
  --build-arg POLARIS_BUILD_VERSION=$(git describe --tags --always) \
  --build-arg POLARIS_GIT_SHA=$(git rev-parse HEAD) \
  --build-arg POLARIS_BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  -t polaris/ingester-api:dev .
```

The trailing `.` is required — the build context is the repository root.

## Building every service

```bash
pnpm docker:build
```

This is a thin wrapper around `node scripts/docker-build.mjs`. Common flags:

```bash
pnpm docker:build -- --list             # list all targets
pnpm docker:build -- --tag v1.2.3       # override the image tag
pnpm docker:build -- ingester-api       # build a single named service
pnpm docker:build -- --no-cache         # ignore build cache
pnpm docker:build -- --dry-run          # print docker commands without running
```

The script captures `POLARIS_BUILD_VERSION` / `POLARIS_GIT_SHA` from the
working tree automatically. Pre-set the env vars to override.

## Runtime configuration

Each service reads its configuration from environment variables validated by
`@polaris/shared-config`. The Dockerfiles bake **no** runtime config. Refer
to each service's `src/config.ts` for the exhaustive list:

- `apps/ingester-api/src/config.ts`
- `apps/control-plane-api/src/config.ts`
- `processors/<name>/v1/src/config.ts`
- `consumers/<name>/v1/src/config.ts`

The shared HTTP, Postgres, Redpanda, Redis, ClickHouse schemas live under
`packages/shared-config/src/schemas/`. Every variable name is prefixed
`POLARIS_*` so there is one obvious namespace to grep for.

Each image sets `POLARIS_HTTP_PORT` to the service's canonical port (see
the table at the top of this file). Override at run time to relocate the
listener:

```bash
docker run -e POLARIS_HTTP_PORT=8080 -p 8080:8080 polaris/ingester-api:dev
```

`POLARIS_HTTP_HOST` defaults to `0.0.0.0` inside the container — required so
Docker's network namespace can route requests in. Do not override unless
binding to a specific interface.

## Secrets

Secrets never enter the image. They are referenced at runtime by the
secret-provider abstraction in `@polaris/shared-secrets`:

```bash
docker run \
  -e POLARIS_SECRET_PROVIDER=env \
  -e POLARIS_POSTGRES_PASSWORD=... \
  polaris/ingester-api:dev
```

In Kubernetes, the standard pattern is Vault Agent or CSI driver
injecting referenced secrets as files / environment variables at pod
start. See `docs/architecture/11-production-readiness.md` "Secret
Management" and `docs/implementation/tasks/P11-004-production-secret-provider.md`.

## Image size budget

Indicative numbers (no formal SLO):

| Stage         | Approximate size |
| ------------- | ---------------- |
| `node:22-alpine` base | ~50 MB    |
| Builder stage (transient) | 1.5–2 GB |
| Final runtime image      | 150–220 MB |

The final image size is dominated by Node 22 itself (~85 MB) and the
service's production `node_modules`. The pnpm deploy step prunes
devDependencies, which is the bulk of the savings.

## Verifying a built image

```bash
# Image metadata.
docker inspect polaris/ingester-api:dev | jq '.[0].Config.Labels'

# Build args surface on /health.
docker run --rm -d -p 4000:4000 --name probe polaris/ingester-api:dev
curl -s http://127.0.0.1:4000/health | jq .
docker stop probe
```

## CI / static checks

`docker build` is a heavy operation and is not part of the workspace gate.
Static linting of the Dockerfiles (`hadolint`) is left to CI. To run
locally if you have `hadolint` installed:

```bash
find apps processors consumers -name Dockerfile -print0 \
  | xargs -0 -n1 hadolint
```

## Known gaps

- **GeoIP `.mmdb`** files are mounted at runtime, not baked into the image.
  See `processors/geoip-enricher/v1/Dockerfile` and the operator runbook.
