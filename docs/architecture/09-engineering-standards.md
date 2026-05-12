# Engineering Standards

## Runtime and Language

Polaris uses strict TypeScript, current Active LTS Node.js, and ESM-first packages/services.

Rules:

- Pin Node.js to the current Active LTS when implementation begins.
- Enable TypeScript `strict`.
- Services run on Node.js.
- Internal packages are ESM-first.
- Browser SDK produces a browser bundle.
- Node SDK is ESM-first.
- CommonJS compatibility is added only when a real consumer requires it.
- Avoid per-package runtime/module drift.

## Monorepo Tooling

Use pnpm workspaces with package scripts first.

Rules:

- Use `pnpm` for workspace/package management.
- Use plain package scripts for v1 build/test/lint orchestration.
- Do not introduce Turborepo or Nx in v1 unless build orchestration becomes painful.
- Prefer internal package references through the workspace protocol where useful.

## PostgreSQL Access

Use Kysely for PostgreSQL access and explicit SQL migrations.

Rules:

- Use Kysely for typed PostgreSQL queries.
- Use explicit SQL migration files for schema changes.
- Raw SQL is allowed for complex or database-specific queries.
- Avoid heavy ORM behavior.
- Keep operational/control-plane tables transparent and reviewable.
- DB types should be generated or maintained consistently with migrations.

## PostgreSQL Migrations

Use SQL-first PostgreSQL migrations, defaulting to dbmate unless implementation-time review finds a better maintained choice.

Rules:

- Migration files are plain SQL.
- Migration history is stored in PostgreSQL.
- Kysely is for typed queries, not the source of schema truth.
- Migration changes must be reviewable as database changes.

## Testing

Use a layered testing strategy with Vitest.

Required test styles:

- unit tests for TypeScript logic
- contract tests for event schemas and mapper behavior
- golden fixtures for canonical event input/output examples
- integration tests for PostgreSQL, Redis, Redpanda, and ClickHouse behavior
- vertical-slice smoke test for the first end-to-end event path

Docker-backed services may be required for integration/e2e tests. Do not build a large platform simulator before the first vertical slice exists.

## IDs and Timestamps

Use UUIDv7 for platform-generated IDs and UTC timestamps everywhere.

Rules:

- SDK-generated `event_id` should be UUIDv7.
- Platform-generated IDs should be UUIDv7, including processor runs, replay jobs, and delivery records.
- ISO 8601 UTC timestamps are used at API boundaries.
- PostgreSQL stores timestamps as `timestamptz`.
- ClickHouse uses UTC-oriented `DateTime64`.
- Preserve producer `occurred_at`.
- The ingester stamps server-side `ingested_at`.
- Avoid local-time semantics in storage and event contracts.

## HTTP Error Contract

Use RFC 7807 Problem Details for request-level HTTP errors.

Rules:

- Request-level failures return `application/problem+json`.
- Problem responses include stable `code` and `request_id`.
- Per-event ingestion failures use machine-readable reason codes inside the batch response.
- Errors should be classified as retryable or permanent where useful.
- SDKs must not retry permanent validation failures.
- SDKs may retry transient request-level failures.

Example:

```json
{
  "type": "https://docs.polaris/errors/invalid-api-key",
  "title": "Invalid API key",
  "status": 401,
  "code": "invalid_api_key",
  "detail": "The provided API key is invalid or revoked.",
  "request_id": "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551"
}
```

## Logging

Use Pino for structured JSON logging through a shared logger package.

Rules:

- JSON logs only.
- Use child loggers for request/source/processor/consumer context.
- Configure redaction for secrets, authorization headers, cookies, tokens, card fields, passwords, and similar sensitive fields.
- Do not log raw event payloads by default.
- Prefer logging event IDs and metadata over full `properties`.
- Full payload logging, if ever needed, must be explicitly debug-gated and redacted.

## Runtime Configuration

Use shared Zod-validated runtime configuration.

Rules:

- Services load runtime config through a shared config package.
- Config schemas are declared with Zod.
- Services fail fast on invalid required config.
- Avoid direct ad hoc `process.env` reads outside the config package.
- Environment variables are the main runtime config source.
- `.env` is acceptable for local development.
- Semantic config remains in versioned files/code, not environment variables.

## Redpanda Client Usage

Use KafkaJS through a thin `shared-kafka` package.

The package standardizes:

- producer creation
- consumer creation
- message headers
- event serialization
- partition key generation
- retry defaults
- metrics hooks
- logging hooks
- topic constants
- DLQ publishing helpers

Do not build a full stream-processing framework in v1. Keep wrappers thin and preserve escape hatches for advanced KafkaJS behavior.

## ClickHouse Access

Use SQL files for ClickHouse DDL/migrations and the official ClickHouse JavaScript client for application/CLI queries.

Rules:

- ClickHouse table definitions, Kafka Engine tables, materialized views, and projections live as SQL files.
- Do not use an ORM for ClickHouse.
- Use the official ClickHouse JavaScript client when services or CLI code need to query ClickHouse.
- Keep ClickHouse-specific behavior visible and SQL-native.

## OpenAPI

Generate OpenAPI from Fastify/Zod route schemas for HTTP APIs.

Rules:

- The Ingester API should expose/generate OpenAPI.
- Future control-plane/admin APIs should expose/generate OpenAPI.
- Route validation schemas should be the practical source of truth.
- Avoid hand-written OpenAPI that can drift from implementation.
- Choose exact Zod/Fastify/OpenAPI tooling during scaffolding.

## Formatting and Linting

Use Biome for formatting and linting in v1.

Rules:

- Use Biome as the default formatter/linter for TypeScript/JavaScript.
- Avoid introducing ESLint unless there is a concrete rule gap.
- Keep style enforcement fast and simple.
- CI should run formatting/lint checks.

## Containers

Package services as compiled JavaScript in slim Node containers.

Rules:

- TypeScript compiles before production run.
- Production containers run built JavaScript, not TypeScript source.
- Do not use `tsx` or runtime TypeScript in production.
- Images include build/version metadata.
- Dockerfiles should be boring and explicit.
- Bundling may be introduced selectively later, but is not the default v1 packaging model.

## Fastify Service Structure

Use Fastify with a thin shared service bootstrap package.

The bootstrap package standardizes:

- config loading
- Pino logger wiring
- request IDs
- RFC 7807 Problem Details errors
- health/readiness routes
- metrics endpoint
- OpenAPI setup
- graceful shutdown
- common hooks

Each service owns its routes and business logic. Do not build a heavy internal application framework in v1.

## CI Quality Gates

Required on every pull request:

```text
typecheck
Biome lint/format check
unit tests
contract/schema tests
event catalog validation
SQL migration validation
build all packages/services
```

Docker-backed integration checks run scheduled, pre-release, or on explicit integration CI triggers until stable:

```text
PostgreSQL
Redis
Redpanda
ClickHouse
vertical-slice smoke test
```

Once stable enough, the vertical-slice smoke test may become a required gate.

## Dependency Policy

Polaris uses a boring, minimal dependency policy.

Rules:

- Use mature, well-maintained libraries for infrastructure concerns.
- Prefer already chosen libraries before adding alternatives.
- Avoid multiple libraries for the same concern.
- Avoid large frameworks without clear need.
- Avoid unmaintained packages.
- Avoid runtime dependencies for trivial utilities.
- New runtime dependencies should have a concrete reason.
- Internal shared packages should standardize repeated infrastructure behavior without becoming heavy frameworks.

## Versioning and Releases

Polaris uses hybrid versioning.

Rules:

- Internal packages use semver.
- Services expose package version, git SHA, build timestamp, and image metadata.
- Processor versions are immutable semantic directories: `v1`, `v2`, etc.
- Consumer versions are immutable semantic directories: `v1`, `v2`, etc.
- Optional pipeline release labels may exist, such as `2026.05`.
- Replay lineage must record exact processor/consumer version, git SHA, config hash, and runtime settings hash where relevant.

