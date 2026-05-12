# ADR 0002: Engineering Decision Ledger

This is a light decision ledger for Polaris implementation standards. The engineering standards handbook is the primary readable source of truth.

## Decisions

1. Use strict TypeScript.
2. Pin Node.js to the current Active LTS when implementation begins.
3. Use ESM-first packages and services.
4. Browser SDKs produce browser bundles.
5. Add CommonJS compatibility only when a real consumer requires it.
6. Use pnpm workspaces.
7. Use package scripts first; avoid Turborepo/Nx in v1.
8. Use Kysely for PostgreSQL access.
9. Use explicit SQL migration files for PostgreSQL schema changes.
10. Default SQL-first migration tooling to dbmate unless implementation-time review finds a better maintained choice.
11. Use Vitest for TypeScript tests.
12. Use layered tests: unit, contract, golden fixtures, integration, and vertical-slice smoke tests.
13. Use UUIDv7 for platform-generated IDs.
14. Use UTC timestamps everywhere.
15. Use RFC 7807 Problem Details for request-level HTTP errors.
16. Use per-event result codes for ingestion batch validation.
17. Use Pino for structured JSON logs.
18. Do not log raw event payloads by default.
19. Use shared Zod-validated runtime configuration.
20. Avoid direct ad hoc `process.env` reads outside the config package.
21. Use KafkaJS through a thin `shared-kafka` package.
22. Use SQL files for ClickHouse DDL and migrations.
23. Use the official ClickHouse JavaScript client for application/CLI queries.
24. Generate OpenAPI from Fastify/Zod route schemas.
25. Use Biome for formatting and linting in v1.
26. Package services as compiled JavaScript in slim Node containers.
27. Do not run TypeScript directly in production containers.
28. Use Fastify with a thin shared service bootstrap package.
29. Required PR checks include typecheck, Biome, unit tests, contract/schema tests, event catalog validation, SQL migration validation, and builds.
30. Docker-backed integration/e2e checks run scheduled, pre-release, or on explicit triggers until stable.
31. Use boring, minimal dependencies.
32. Use hybrid versioning: semver packages, build metadata services, immutable vN processors/consumers, optional pipeline labels.

## Review Rule

Engineering standards should stay boring. Add tools only when they remove real recurring complexity or protect important platform guarantees.

