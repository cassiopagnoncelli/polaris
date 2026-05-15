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

secrets          provider-based references in PostgreSQL
                 (secret_provider + secret_ref). Plaintext lives in
                 the provider only. See secrets section below.
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
  `processors/<name>/v1/src/config.ts` or
  `consumers/<name>/v1/src/config.ts`, it is local to that service.

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
- Secrets are referenced, not written. The secret provider (today
  `env`; Vault from [P11-004](../../agents/pm/kanban/done/P11-004-production-secret-provider-adapter-vault.md))
  injects values into the process environment at boot. PostgreSQL
  stores the reference; never the plaintext.
- Build metadata flows through to `/health` via the three Docker build
  args documented in [`infra/docker/README.md`](../../infra/docker/README.md).

Kubernetes manifest examples are not committed in this task. A future
follow-up adds opinionated Deployment / Service / NetworkPolicy
templates under `infra/k8s/`; until then, operators wire the contracts
described here through their existing manifest tooling.

## Secrets

Polaris stores `(secret_provider, secret_ref)` pairs in PostgreSQL,
never plaintext. The secret provider abstraction lives in
[`packages/shared-secrets/`](../../packages/shared-secrets/). It ships
the `env` adapter; the Vault adapter is [P11-004](../../agents/pm/kanban/done/P11-004-production-secret-provider-adapter-vault.md).

Three rules apply at deployment time:

1. **No secret in this repo.** Every secret-bearing variable in
   `.env.example` is empty and carries an `# OBTAIN FROM <provider>` note.
   Reviewers should `rg -n "password|secret|token|key" .env.example config infra docs/deployment`
   and confirm the only matches are the schema-driven variable names
   and the documentation that explains them.
2. **No secret in image build args.** The Docker `--build-arg` surface
   is for build metadata only ([`infra/docker/README.md`](../../infra/docker/README.md)).
3. **No secret in logs, audit, DLQ payloads, or delivery records.** This
   is enforced by Pino redaction (see
   [`docs/architecture/09-engineering-standards.md`](../architecture/09-engineering-standards.md)
   "Logging") and the secret-provider contract (see
   [`packages/shared-secrets/src/types.ts`](../../packages/shared-secrets/src/types.ts)).

Operators provision secret values directly in the chosen provider; the
runtime resolves references at boot.

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
- **No Vault wiring.** The `env` secret provider is the only adapter in
  v1. [P11-004](../../agents/pm/kanban/done/P11-004-production-secret-provider-adapter-vault.md)
  ships the Vault adapter; `.env.example` does not pre-template Vault
  variables to avoid documenting unwired code.
- **GeoIP database.** `POLARIS_GEOIP_DB_PATH` is reserved in
  `.env.example` but the v1 enricher does not read it (the MaxMind
  adapter is a future task; see
  [`processors/geoip-enricher/v1/src/config.ts`](../../processors/geoip-enricher/v1/src/config.ts)).
