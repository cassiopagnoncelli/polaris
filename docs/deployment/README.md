# Polaris Deployment

Operator entry point for deploying Polaris services. This directory holds
the artifacts that bridge "what the code is" and "how an operator runs
it in production":

| Doc | What it covers |
| --- | --- |
| [`config-reference.md`](./config-reference.md) | Per-service required/optional environment variables. |
| [`data-classes.md`](./data-classes.md) | Data classification by table/topic, retention, regulatory class. |
| [`../../.env.example`](../../.env.example) | The single template for every `POLARIS_*` variable a service may read. |

The platform's production posture is locked in
[`docs/architecture/11-production-readiness.md`](../architecture/11-production-readiness.md);
the observability service contract is in
[`docs/architecture/08-observability-and-operations.md`](../architecture/08-observability-and-operations.md);
the operator runbooks (backup, retention, DLQ triage, topic isolation
cutover) live in [`docs/operations/`](../operations/).

## Configuration model

```text
runtime config   environment variables, validated by Zod schemas in
                 packages/shared-config/src/schemas/. Service fails
                 fast on bad input. Documented in .env.example.

semantic config  versioned code/files. Event catalog, mapping
                 definitions, processor manifests, ClickHouse DDL,
                 SDK contracts. Never an environment variable. See
                 docs/architecture/02-control-plane.md.

secrets          per-project credentials stored in PostgreSQL as
                 plaintext (destinations.secret_value,
                 project_config with is_secret). App/deployment
                 credentials stay environment variables. See secrets
                 section below.
```

The split matters. A "config change" that alters a schema, mapping, or
processor wiring requires a code change (with PR review, CI, and
versioned lineage). A "config change" that bumps a timeout or a pool
size is an environment variable on the deployment. Mixing the two is
explicitly out of scope; the platform refuses to load semantic config
from environment variables.

## Container images and build args

Container images are the deployable artifact. The build details, the
per-service Dockerfiles, the `POLARIS_BUILD_VERSION` /
`POLARIS_GIT_SHA` / `POLARIS_BUILD_TIME` build-arg contract, and the
secrets/healthcheck contract are documented in
[`infra/docker/README.md`](../../infra/docker/README.md). This file does
not duplicate that text.

## Environment variables

Every runtime-tunable knob is a `POLARIS_*` environment variable.
`.env.example` at the repo root is the authoritative inventory. Each
variable is grouped by the component that owns it; each carries a
one-line comment describing what it does and whether it is required.

The single rule of thumb:

- if it is in `packages/shared-config/src/schemas/`, it is shared infrastructure
  (every service reads it).
- if it is in `apps/<service>/src/config.ts` or
  `{sync,async}/<stage>/<name>/v1/src/config.ts` or
  `sync/destinations/<name>/v1/src/config.ts`, it is local to that service.

A per-service summary, including which shared blocks each service
composes, lives in [`config-reference.md`](./config-reference.md).

## Local development

Local Docker Compose stacks live at the repo root:

```bash
docker compose up                                              # core data path
docker compose -f docker-compose.yml -f docker-compose.observability.yml up
```

Copy `.env.example` to `.env.local` and fill in values for the local
stack. The shared-config loader will pick it up automatically (see
`packages/shared-config/src/loader.ts` precedence rules).

## Production deployments

Production deployments run on Kubernetes per
[`docs/architecture/11-production-readiness.md`](../architecture/11-production-readiness.md).
A few platform invariants:

- Services read configuration only from environment variables. No `.env`
  file is read from disk on a production host; the orchestrator
  injects every `POLARIS_*` variable directly.
- App and deployment credentials are injected by the orchestrator as
  environment variables at boot. Per-project credentials are not: they
  live in the control-plane database, which therefore holds live
  secrets. See the secrets section below.
- Build metadata flows through to `/health` via the three Docker build
  args documented in [`infra/docker/README.md`](../../infra/docker/README.md).

Kubernetes manifest examples are not committed in this task. A future
follow-up adds opinionated Deployment / Service / NetworkPolicy
templates under `infra/k8s/`; until then, operators wire the contracts
described here through their existing manifest tooling.

## Secrets

Two kinds, stored differently.

**Per-project credentials** — a destination's vendor token, a project's
sensitive configuration values — live in the control-plane database as
plaintext (`destinations.secret_value`, `project_config.value` with
`is_secret`). There is no external provider and no resolution step.
The deployment consequence is direct: **the control-plane database and
its backups are credential material**, and their access controls should
match. See [Control Plane — Secrets](../architecture/02-control-plane.md).

**App and deployment credentials** — Postgres, RabbitMQ, ClickHouse,
Redis — are environment variables injected by the orchestrator, read at
bootstrap before a service can reach any store. The rules below are
about these.

Three rules apply at deployment time:

1. **No secret in this repo.** Every secret-bearing variable in
   `.env.example` is empty and carries an `# OBTAIN FROM <provider>` note.
   Reviewers should `rg -n "password|secret|token|key" .env.example config infra docs/deployment`
   and confirm the only matches are the schema-driven variable names
   and the documentation that explains them.
2. **No secret in image build args.** The Docker `--build-arg` surface
   is for build metadata only ([`infra/docker/README.md`](../../infra/docker/README.md)).
3. **No secret in logs, audit, DLQ payloads, or delivery records.** Three
   mechanisms, because per-project credentials are now plaintext in the
   database and one convention would not hold: Pino redaction (see
   [`docs/architecture/09-engineering-standards.md`](../architecture/09-engineering-standards.md)
   "Logging"); masking at the data layer, so a credential never reaches a
   list view, export or audit snapshot to begin with
   ([`libs/tenancy/control-plane/src/secret-masking.ts`](../../libs/tenancy/control-plane/src/secret-masking.ts));
   and `Secret<T>` boxing at the point of use, whose `toString` / `toJSON`
   both yield `[redacted]`
   ([`libs/tenancy/project-config/src/secret-box.ts`](../../libs/tenancy/project-config/src/secret-box.ts)).

Operators set per-project credentials with `polaris destinations create
--secret-value` and `polaris config set --secret`, and rotate them with
`polaris destinations rotate-secret`. Nothing resolves a reference at boot;
see the [secret rotation runbook](../operations/secret-rotation.md).

## Observability

Every service exposes `/health`, `/ready`, a Prometheus-compatible
`/metrics` endpoint, and structured Pino JSON logs. The scraper config
that pulls those metrics lives in
[`infra/prometheus/prometheus.yml`](../../infra/prometheus/prometheus.yml)
and the local dashboards in
[`infra/grafana/dashboards/`](../../infra/grafana/dashboards/).
Production deployments point their own Prometheus / Grafana / Loki
backends at the same shapes; the contract is in
[`docs/architecture/08-observability-and-operations.md`](../architecture/08-observability-and-operations.md).

## Backup and recovery

Runbooks for backup, restore, and quarterly recovery drills live in
[`docs/operations/backup-and-retention.md`](../operations/backup-and-retention.md).
The recovery-objective table is also reproduced in
[`docs/architecture/11-production-readiness.md`](../architecture/11-production-readiness.md)
"Backup and Recovery"; the architecture doc is canonical.

## Known gaps

- **No Kubernetes manifests.** The platform has no opinionated Helm
  chart, kustomize base, or kubectl manifests in v1. Operators apply
  the contracts here through their existing manifest tooling. A
  follow-up task will land `infra/k8s/` once a real production
  deployment shape is in flight.
- **No external secret manager.** Per-project credentials are plaintext
  in the control-plane database. A Vault adapter existed (P11-004) and
  was removed when those credentials moved into the database, which
  left it with no callers. Encrypting them at rest, or moving them back
  behind a provider, is honest future work.
- **GeoIP database.** `POLARIS_GEOIP_DB_PATH` is reserved in
  `.env.example` but the v1 enricher does not read it (the MaxMind
  adapter is a future task; see
  [`sync/enrichment/runtime/v1/src/config.ts`](../../sync/enrichment/runtime/v1/src/config.ts)).
