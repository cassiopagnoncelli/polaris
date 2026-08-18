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

``text
polaris projects list
polaris sources sync
polaris keys create --project storefront --env production --source storefront-web
polaris keys revoke ...
polaris schemas validate
polaris replays create ...
polaris replays approve ...
polaris destinations disable ...
``

### Access model

The CLI is bash-invocable. There is no interactive login. Authentication is via env vars in the AWS-CLI / GitHub-CLI tradition:

``bash
export POLARIS_API_URL="https://polaris.example.internal"
export POLARIS_TOKEN="polaris_ot_..."
polaris keys create --project storefront --env production --source storefront-web
``

- `POLARIS_TOKEN` is issued by `polaris operators create` and shown once at creation.
- Token rotation (`polaris operators rotate`) issues a new token and revokes the old one immediately; the operator updates their env var.
- Per-environment profiles live in `~/.polaris/config.toml`. The config file never stores tokens — it points at env var names:

``toml
[profiles.production]
url = "https://polaris.example.internal"
token_env = "POLARIS_PROD_TOKEN"

[profiles.staging]
url = "https://polaris-staging.example.internal"
token_env = "POLARIS_STAGING_TOKEN"
``

- Profile is selected via `--profile <name>` or `POLARIS_PROFILE` env var.

### Implementation shape

The CLI is a thin client that talks to a small Polaris control-plane API service. This shape is recommended (not strictly required for v1) for three reasons:

- Audit records are written server-side atomically with the mutation, so an operator-side network failure cannot leave a mutation without an audit row.
- Operators don't need direct PostgreSQL network reach; only the control-plane API service does.
- A future admin UI reuses the same API.

The control-plane API service lives in `apps/control-plane-api/` and exposes the same operations the CLI invokes. The implementation choice is reconfirmed in `P6-001`.

The CLI should use libraries/services that a future admin API or UI can reuse. No admin UI is required in v1.

## Operator Identity and Audit Actor

Polaris's operator gate is intentionally minimal: one property per command, one rule, one audit record per command.

### Actor sources

``text
operator_token  CLI verified an operator token against its argon2id hash
declared        control-plane API authenticated a bearer token or an IdP-backed admin session
cli             no credential — the CLI's fallback when a token is absent, malformed,
                revoked, or fails verification
migration       written by a schema migration
system          written by the platform rather than a person
``

The names carry history worth knowing. An earlier draft of this design
used `cli_token` / `cli_oidc` / `declared`, where `declared` meant a
self-asserted `--actor` name. The implementation kept the *word* and
inverted the *meaning*: nothing in Polaris ever accepted an unverified
actor name, so `declared` came to mean "authenticated by the API" and
`cli` became the unauthenticated fallback. `operator_token` was split out
of `declared` later so an incident review can tell a CLI mutation from an
admin-panel one.

### The rule

Each CLI command declares `mutates: boolean` as part of its definition. The dispatcher applies one rule before executing:

``text
if command.mutates && environment === 'production'
   && actorSource not in { 'operator_token', 'declared' }:
    reject with "production mutation requires an authenticated operator"
else:
    allow
``

The gate lists what it ALLOWS rather than excluding `cli`, so a future
actor source has to be admitted deliberately instead of clearing a
production gate by merely existing.

That is the entire gate. No risk tiers, no per-command lists, no separate gate-decision records.

Read-only commands (list, inspect, plan, dry-run) carry `mutates: false` and bypass the gate. Mutating commands in non-production environments bypass the gate so dev and staging stay friction-free.

### v1 implementation

- `operator_token` is the CLI's authenticated source; `declared` is the
  control-plane API's.
- Each operator has a personal token, bound to environment and actor identity. Tokens are hashed in PostgreSQL alongside API keys, never stored plaintext.
- Tokens can be issued and revoked through the CLI. Rotation issues a new token and immediately revokes the old one with no grace period. If overlap is needed, the operator issues a second token first, uses it, then revokes the original later.
- There is no `--actor` flag that sets an actor. The design above allowed one as a display label; the implementation does not, and `--actor` exists only as a filter on `polaris audit list` / `polaris export audit`. An actor label always comes from the verified credential, so it cannot be forged into someone else's name.

### Audit record contents

Every mutating command writes one audit record:

``text
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
``

Denied gate decisions land on the same record (`result = denied`, `denied_reason` set). A separate gate-decision record was considered and rejected — it doubled audit volume without adding information.

Audit records never store credentials, secrets, or full request bodies that may include them.

## Projects and Environments

Polaris supports multiple internal projects.

Core environments are fixed:

``text
development
staging
production
``

Rules:

- API keys are bound to one project and one environment.
- The ingester stamps `environment` from the API key.
- Producers do not send or override `environment`.
- Future ephemeral environments may exist, but must be explicitly marked, short-lived, quota-limited, and have destination delivery disabled by default.

## Sources

Sources are explicit platform objects.

Examples:

``text
storefront-web
payments-api
billing-worker
shopify-webhook-relay
``

Source declarations are file-backed and materialized into PostgreSQL for runtime use.

A source includes:

``text
project_id
source_id
source_type
owner
description
runtime
allowed environments
status
``

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

Secrets split in two, and the split is the whole design.

**Per-project secrets** — a destination's vendor credential, and a project's own sensitive configuration values — are stored in the control-plane database as plaintext:

``text
destinations.secret_value    the vendor credential itself
project_config.value         with is_secret = true
``

This reverses the platform's earlier rule. PostgreSQL used to store `(secret_provider, secret_ref)` pairs that an adapter resolved at the point of use, and "PostgreSQL never stores plaintext secrets" was load-bearing. The reversal buys one storage mechanism for everything a project declares, editable from the admin UI, with no external dependency in the read path — and it costs exactly what it sounds like: **access to the control-plane database is access to every project's vendor accounts.** Its backups and replicas are credential material. Restrict them accordingly.

**App and deployment secrets** — the Postgres DSN, the broker password, ClickHouse credentials — are unchanged and never went through a provider either. A service reads them from its environment at bootstrap, before it can reach any store.

Repo files never store plaintext secrets.

What storing plaintext does NOT relax is handling. A secret is still forbidden from logs, delivery records, DLQ payloads, audit payloads and exports, and two mechanisms keep it out rather than one convention:

- **Masking, at the data layer.** `listProjectConfig` returns `[redacted]` for a secret row; the destination readers do not select `secret_value` at all. A caller that needs plaintext asks by name — `revealProjectConfigSecret`, one function, greppable. There is no equivalent for destination credentials: they are write-only through every Polaris surface, set at create, replaced with `polaris destinations rotate-secret`, never printed back.
- **Boxing, at the point of use.** A value a consumer legitimately holds arrives wrapped in `Secret<T>`, whose `toString`, `toJSON` and inspect hooks all yield `[redacted]`. Disclosure requires an explicit `.expose()`.

Rotation is a database write that announces itself through `LISTEN/NOTIFY`; see the [secret rotation runbook](../operations/secret-rotation.md).

