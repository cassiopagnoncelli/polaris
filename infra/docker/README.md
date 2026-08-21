# Polaris Docker images

This directory holds the canonical Dockerfile template and the documentation
that ties the per-service Dockerfiles together. The actual build files live
next to each service:

| Service                                  | Dockerfile                                            | Image                                            | Port |
| ---------------------------------------- | ----------------------------------------------------- | ------------------------------------------------ | ---- |
| `ingester-api`                           | `apps/ingester-api/Dockerfile`                        | `polaris/ingester-api`                           | 4000 |
| `control-plane-api`                      | `apps/control-plane-api/Dockerfile`                   | `polaris/control-plane-api`                      | 4001 |
| `polaris-cli`                            | `apps/polaris-cli/Dockerfile`                         | `polaris/polaris-cli`                            | —    |
| `sessionizer v1`                         | `async/computation/sessionizer/v1/Dockerfile`                | `polaris/processor-sessionizer-v1`               | 4012 |
| `sync-enrichment runtime v1`             | `sync/enrichment/runtime/v1/Dockerfile`               | `polaris/sync-enrichment-runtime-v1`             | 4015 |
| `clickhouse-sink v1`                     | `async/warehouse/clickhouse-sink/v1/Dockerfile`       | `polaris/consumer-clickhouse-sink-v1`            | 4016 |
| `sessionizer v2`                         | `async/computation/sessionizer/v2/Dockerfile`         | `polaris/processor-sessionizer-v2`               | 4017 |
| `sync-identity resolver v1`              | `sync/identity/resolver/v1/Dockerfile`                | `polaris/sync-identity-resolver-v1`              | 4018 |
| `attribution-engine v2`                  | `async/computation/attribution-engine/v2/Dockerfile`  | `polaris/processor-attribution-engine-v2`        | 4019 |
| `attribution-engine v3`                  | `async/computation/attribution-engine/v3/Dockerfile`  | `polaris/processor-attribution-engine-v3`        | 4020 |
| `merge-worker v1`                        | `async/merges/merge-worker/v1/Dockerfile`             | `polaris/processor-merge-worker-v1`              | 4021 |
| `webhook-sink v1`                        | `sync/destinations/webhook-sink/v1/Dockerfile`                | `polaris/consumer-webhook-sink-v1`               | 5000 |
| `meta-capi v1`                           | `sync/destinations/meta-capi/v1/Dockerfile`                   | `polaris/consumer-meta-capi-v1`                  | 5001 |
| `tiktok v1`                              | `sync/destinations/tiktok/v1/Dockerfile`                      | `polaris/consumer-tiktok-v1`                     | 5003 |
| `ga4 v1`                                 | `sync/destinations/ga4/v1/Dockerfile`                         | `polaris/consumer-ga4-v1`                        | 5002 |
| `braze v1`                               | `sync/destinations/braze/v1/Dockerfile`                       | `polaris/consumer-braze-v1`                      | 5004 |

The polaris-cli image is a CLI bin, not a long-running server — it has no
exposed port and no `HEALTHCHECK`.

**This table is the port registry, and keeping it current is the point.**
It went five services stale, and every one of the resulting collisions
was invisible to typecheck, lint and tests:

  * `sync-identity` shipped on 4011 (inherited from the legacy
    identity-resolver chassis it was copied from) while its dev script
    and its Prometheus scrape job both said 4014 — which is
    attribution-engine's port. In a container the stage was never
    scraped; the job scraped ATTRIBUTION metrics and labelled them
    `sync-identity-resolver`. Mislabelled data is worse than missing.
  * `sessionizer v2` shipped on 4012, v1's port, so the two versions
    that exist precisely to run side by side could not both start.
  * `attribution-engine v2` shipped on 4014, v1's port, for the same
    reason.

Two rules follow, and they cost nothing at the time:

1. A new version gets a NEW port, never its predecessor's. Coexistence
   is the whole reason a new major exists; two versions on one port
   cannot coexist on one host.
2. Add the row here in the same change that adds the Dockerfile, and
   check the Dockerfile, the `dev` script, and the Prometheus scrape job
   agree. Those three drifting apart is what produced every case above.

Next free port: 4022 (processors), 5005 (destination consumers).

## Architectural decisions

### Per-service Dockerfiles, not a chained base image

Each service ships a complete, standalone Dockerfile. `infra/docker/base.Dockerfile`
is a **reference template**: no image is built `FROM` it, and no service depends
on it at build time.

It is nevertheless built. Since card `5OV81` it is a target in
`scripts/docker-build.mjs` and a member of the per-push set in
`.github/workflows/images.yml`, parameterised with a real `SERVICE_FILTER` so
the build exercises the template's own shape. Being the file every other
Dockerfile is copied from is precisely why it needs a build of its own: the
one time the seventeen were fixed and this file was not, nothing noticed for
months.

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
`@polaris/runtime-secrets`). It ships prebuilt `linux-musl-x64-gnu` and
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

That replacement is `injectWorkspacePackages: true` in `pnpm-workspace.yaml`,
not something `deploy` does on its own. Without it, pnpm v10 and later refuse
the command outright, and the `--legacy` mode that does run leaves the
`workspace:*` deps as symlinks into `/workspace` — a directory that exists in
the builder stage and nowhere else, so `COPY --from=builder /deploy /app`
carries links whose targets it did not copy. The setting is what makes the
sentence above true, and
[ADR-0008](../../docs/adr/0008-inject-workspace-packages-on-deploy.md) records
why injection rather than `--legacy`.

The pnpm version is not written in any Dockerfile. `packageManager` in the
root `package.json` is its one home and pnpm self-manages to it, so the images
install it unpinned. Three stale copies of that number have already cost this
repository a working build.

### Non-root user, `tini` as PID 1

Every image creates `polaris` (uid 1001, gid 1001) and runs as that user.
`tini` is the entrypoint, which:

- forwards POSIX signals (`SIGTERM`, `SIGINT`) to the Node process so
  graceful shutdown handlers in `@polaris/runtime-service-bootstrap` fire.
- reaps zombie children if the service ever shells out (it does not today;
  defensive insurance).

### Healthcheck contract

`HEALTHCHECK` is installed on every long-running service and hits
`http://127.0.0.1:${POLARIS_HTTP_PORT}/health` over loopback. `/health` is
the shared bootstrap's liveness route (see
`libs/runtime/service-bootstrap/src/bootstrap/health.ts`). It returns
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
`@polaris/runtime-config`. The Dockerfiles bake **no** runtime config. Refer
to each service's `src/config.ts` for the exhaustive list:

- `apps/ingester-api/src/config.ts`
- `apps/control-plane-api/src/config.ts`
- `{sync,async}/<stage>/<name>/v1/src/config.ts`
- `sync/destinations/<name>/v1/src/config.ts`

The shared HTTP, Postgres, RabbitMQ, Redis, ClickHouse schemas live under
`libs/runtime/config/src/schemas/`. Every variable name is prefixed
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

Secrets never enter the image.

App and deployment credentials are injected as environment variables at
container start:

```bash
docker run \
  -e POLARIS_POSTGRES_PASSWORD=... \
  polaris/ingester-api:dev
```

Per-project credentials — a destination's vendor token, a project's
sensitive configuration values — are not environment variables at all.
They live in the control-plane database, which the container reaches
with the Postgres credentials above. See
`docs/architecture/02-control-plane.md` "Secrets".

In Kubernetes, inject the environment variables from a Secret object as
usual. There is no secret-provider sidecar to run: nothing in the image
resolves secret references any more.

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
Two checks that do run in `pnpm lint` cover the parts of an image build that
are decided outside the Dockerfile, because both had already broken every
image once without turning anything red:

- `scripts/lint-docker-context.mjs` — no `COPY` names a path `.dockerignore`
  prunes from the build context.
- `scripts/lint-docker-deploy.mjs` — injection is on, so `pnpm deploy` runs at
  all; every deploy filter names the package sitting beside it, so it resolves
  to something; and no Dockerfile pins a pnpm version.

Static linting of the Dockerfiles (`hadolint`) is left to CI. To run
locally if you have `hadolint` installed:

```bash
find apps processors consumers -name Dockerfile -print0 \
  | xargs -0 -n1 hadolint
```

## Mounted data: the GeoIP database

One image reads a file that is not in it. `sync/enrichment/runtime/v1`
composes the geo enricher, which needs a MaxMind GeoLite2 `.mmdb` —
license-restricted, so it cannot be committed or pushed inside an image,
and ~60 MB refreshed twice a week, so it would be the largest and most
frequently invalidated layer of an image whose code changes far less
often. It is fetched on the host by
[`infra/geoip/refresh-geoip.sh`](../geoip/refresh-geoip.sh) and mounted.

| | |
| --- | --- |
| Mount | the **directory** `/etc/polaris/geoip`, read-only |
| Variable | `POLARIS_SYNC_ENRICHMENT_GEOIP_DB_PATH=/etc/polaris/geoip/GeoLite2-City.mmdb` |
| Absent | supported — one boot warning, `geo.source: "no_lookup"` on every event |

```bash
docker run \
  -v /srv/polaris/geoip:/etc/polaris/geoip:ro \
  -e POLARIS_SYNC_ENRICHMENT_GEOIP_DB_PATH=/etc/polaris/geoip/GeoLite2-City.mmdb \
  polaris/sync-enrichment-runtime-v1:dev
```

In Kubernetes the same shape is a `hostPath` or a `PersistentVolumeClaim`
the refresh CronJob writes and the stage mounts `readOnly: true`:

```yaml
    volumeMounts:
      - name: geoip
        mountPath: /etc/polaris/geoip
        readOnly: true
volumes:
  - name: geoip
    persistentVolumeClaim:
      claimName: polaris-geoip
```

**Mount the directory, not the file.** The refresh installs a new
database with `mv`, which replaces the inode. A bind mount of the file
pins the container to the inode it started with, so it keeps serving the
superseded database after every refresh and nothing reports it — the
`source` stamped on its events would still name the old build date,
which is the only place it would show.

The stage reads the file once at boot and holds it, so picking up a
refresh means restarting the pods. See
[the runbook](../../docs/operations/runbook-geoip-refresh.md) for the
cadence and for how to check what a running pod actually loaded.

## Known gaps

- **No image runs from a manifest in this repository.** The compose files
  run the stores and the observability stack; no chart, kustomize base or
  manifest here starts a Polaris service container, so the mount above is
  a contract operators apply through their own tooling rather than a file
  to edit. Tracked with the other deployment gaps in
  [`docs/deployment/README.md`](../../docs/deployment/README.md).
