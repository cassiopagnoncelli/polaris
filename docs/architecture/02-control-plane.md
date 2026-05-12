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

The CLI should use libraries/services that a future admin API or UI can reuse. No admin UI is required in v1.

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

