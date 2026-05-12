# Control Plane

## Design Position

Polaris is file-heavy and database-light.

Semantic platform truth lives in files and code. PostgreSQL stores mutable runtime/control state.

This keeps the platform scrutable while still allowing operational control where runtime state is necessary.

## Files and Code Own

- event catalog
- event schemas
- Zod validators
- destination mapping definitions
- destination mapper implementations
- processor implementations
- processor manifests
- SDK contracts
- ClickHouse DDL and migrations
- documentation
- seed declarations

PostgreSQL must not be able to silently redefine semantic meaning.

## PostgreSQL Owns

- API key hashes and metadata
- source/key runtime state
- destination instance runtime state
- credential references
- processor activation/runtime state
- processor runs
- replay jobs
- delivery records
- audit records
- operational cursors where needed

PostgreSQL records may reference file-defined objects by stable ID and version.

## Redis Role

Redis may be used for:

- API key lookup cache
- source lookup cache
- ingress dedupe window
- rate limiting
- short-lived processor state
- ephemeral idempotency windows

Redis is not canonical for durable platform state.

## CLI-First Control Plane

The v1 operator interface is a `polaris` CLI.

Examples:

```text
polaris projects list
polaris sources sync
polaris keys create --project storefront --env production --source storefront-web
polaris keys revoke ...
polaris schemas validate
polaris replays create ...
polaris replays approve ...
polaris destinations disable ...
```

### Access model

The CLI is bash-invocable. There is no interactive login. Authentication is via env vars in the AWS-CLI / GitHub-CLI tradition:

```bash
export POLARIS_API_URL="https://polaris.example.internal"
export POLARIS_TOKEN="polaris_ot_..."
polaris keys create --project storefront --env production --source storefront-web
```

- `POLARIS_TOKEN` is issued by `polaris operators create` and shown once at creation.
- Token rotation (`polaris operators rotate`) issues a new token and revokes the old one immediately; the operator updates their env var.
- Per-environment profiles live in `~/.polaris/config.toml`. The config file never stores tokens — it points at env var names:

```toml
[profiles.production]
url = "https://polaris.example.internal"
token_env = "POLARIS_PROD_TOKEN"

[profiles.staging]
url = "https://polaris-staging.example.internal"
token_env = "POLARIS_STAGING_TOKEN"
```

- Profile is selected via `--profile <name>` or `POLARIS_PROFILE` env var.

### Implementation shape

The CLI is a thin client that talks to a small Polaris control-plane API service. This shape is recommended (not strictly required for v1) for three reasons:

- Audit records are written server-side atomically with the mutation, so an operator-side network failure cannot leave a mutation without an audit row.
- Operators don't need direct PostgreSQL network reach; only the control-plane API service does.
- A future admin UI reuses the same API.

The control-plane API service lives in `apps/control-plane-api/` and exposes the same operations the CLI invokes. The implementation choice is reconfirmed in [P6-001](../implementation/tasks/P6-001-cli-shell.md).

The CLI should use libraries/services that a future admin API or UI can reuse. No admin UI is required in v1.

## Operator Identity and Audit Actor

Polaris's operator gate is intentionally minimal: one property per command, one rule, one audit record per command.

### Actor sources

```text
cli_oidc    authenticated through Keycloak (org IdP)   (P11+ stretch goal, not v1)
cli_token   long-lived operator token, scoped per environment   (v1 authenticated source)
declared    --actor flag, env var, OS user, git identity   (display only)
```

### The rule

Each CLI command declares `mutates: boolean` as part of its definition. The dispatcher applies one rule before executing:

```text
if command.mutates && environment === 'production' && actorSource === 'declared':
    reject with "production mutation requires an authenticated operator"
else:
    allow
```

That is the entire gate. No risk tiers, no per-command lists, no separate gate-decision records.

Read-only commands (list, inspect, plan, dry-run) carry `mutates: false` and bypass the gate. Mutating commands in non-production environments bypass the gate so dev and staging stay friction-free.

### v1 implementation

- `cli_token` is the only authenticated source in v1.
- Each operator has a personal token, bound to environment and actor identity. Tokens are hashed in PostgreSQL alongside API keys, never stored plaintext.
- Tokens can be issued and revoked through the CLI. Rotation issues a new token and immediately revokes the old one with no grace period. If overlap is needed, the operator issues a second token first, uses it, then revokes the original later.
- `--actor` is a display label only. When the source is `cli_token`, `--actor` overrides `actor_display` in the audit record but cannot change `actor_id`. When the source is `declared`, `--actor` sets the display name but does not upgrade the source.

### Audit record contents

Every mutating command writes one audit record:

```text
audit_id
occurred_at
command
arguments_redacted
mutates
actor_id
actor_source
actor_display
project_id
environment
result            allowed | denied
denied_reason     null | "production_requires_authenticated_actor" | ...
correlation_id
```

Denied gate decisions land on the same record (`result = denied`, `denied_reason` set). A separate gate-decision record was considered and rejected — it doubled audit volume without adding information.

Audit records never store credentials, secrets, or full request bodies that may include them.

## Projects and Environments

Polaris supports multiple internal projects.

Core environments are fixed:

```text
development
staging
production
```

Rules:

- API keys are bound to one project and one environment.
- The ingester stamps `environment` from the API key.
- Producers do not send or override `environment`.
- Future ephemeral environments may exist, but must be explicitly marked, short-lived, quota-limited, and have destination delivery disabled by default.

## Sources

Sources are explicit platform objects.

Examples:

```text
storefront-web
payments-api
billing-worker
shopify-webhook-relay
```

Source declarations are file-backed and materialized into PostgreSQL for runtime use.

A source includes:

```text
project_id
source_id
source_type
owner
description
runtime
allowed environments
status
```

The ingester reads source/key runtime state from PostgreSQL, usually through an in-memory or Redis cache.

## API Keys

Polaris uses multiple source-scoped write keys per `project_id + environment`.

Each key is bound to:

- `project_id`
- `environment`
- `source_id`
- `source_type`

Source types include:

- `web`
- `backend`
- later: `mobile`, `webhook`, `job`

Rules:

- Frontend keys are publishable write keys, not secrets.
- Backend keys are secret server-side keys.
- Raw key values are never stored.
- PostgreSQL stores hashes and metadata.
- Keys can be revoked and rotated.
- Frontend keys rely on origin checks, rate limits, schema validation, max batch size, forbidden-field checks, and revocation.
- The v1 model identifies and constrains source/environment.
- The model remains compatible with future optional scopes, allowlists, expirations, or event-prefix restrictions.

## Secrets

Polaris uses provider-based secret references.

PostgreSQL stores:

```text
secret_provider
secret_ref
optional owner/status/rotation metadata
```

PostgreSQL never stores plaintext secrets. Repo files never store plaintext secrets.

Examples:

```text
secret_provider = env
secret_ref = META_CAPI_TOKEN_STOREFRONT_PROD
```

```text
secret_provider = secret_manager
secret_ref = polaris/production/storefront/meta-capi
```

Local/dev may use environment variables or `.env`. Production can use an external secret manager later. Secrets must never be logged, exported in delivery records, or written to audit payloads.

