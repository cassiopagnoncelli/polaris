---
id: 0002
title: Engineering standards decisions ledger
status: Accepted
date: 2026-05-12
deciders: legacy
supersedes:
superseded_by:
---

## Context and Problem Statement

Polaris implementation needed a small, boring set of engineering standards before any code landed: language choice, runtime, package manager, lint, test framework, log format, error shape, container shape, CI surface. Without recording these as a ledger, every new package would re-debate the same boring choices.

This ADR is the legacy engineering decision ledger from the first implementation pass, transplanted from `docs/adr/0002-engineering-decisions.md` into MADR shape. The engineering standards handbook under `docs/architecture/09-engineering-standards.md` remains the prose source of truth.

Maturity tier assumed: SMB. The standards intentionally favor "boring" tools that scale from one developer to a small team.

## Decision Drivers

- Engineering standards must stay boring; tools earn their place by removing recurring complexity, not by being interesting.
- Platform guarantees (typed boundaries, structured logs, deterministic builds, schema-validated config) must be enforceable in CI.
- Required PR checks must be the same set every contributor runs locally.
- Production containers must not depend on TypeScript transpilation or dev-only tooling.

## Considered Options

- A single engineering ledger (this file) — many decisions per ADR, handbook alongside
- One MADR per individual choice (~30 files) — full per-decision drivers/options
- No ledger; rely on PR review to enforce convention

## Decision Outcome

Chosen: **engineering standards ledger transplanted as a single MADR**, preserving the original numbered list. The handbook explains how each standard plays out in a package; this ADR is the citation surface.

The numbered engineering decisions:

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
23. Use `packages/shared-clickhouse/` (wrapping the official `@clickhouse/client`) for application/CLI queries. Direct imports of the official client outside that package are blocked by an import-restriction rule.
24. Generate OpenAPI from Fastify/Zod route schemas.
25. Use Biome for formatting and linting in v1.
26. Package services as compiled JavaScript in slim Node containers.
27. Do not run TypeScript directly in production containers.
28. Use Fastify with a thin shared service bootstrap package.
29. Required PR checks include typecheck, Biome, unit tests, contract/schema tests, event catalog validation, SQL migration validation, and builds.
30. Docker-backed integration/e2e checks run scheduled, pre-release, or on explicit triggers until stable.
31. Use boring, minimal dependencies.
32. Use hybrid versioning: semver packages, build metadata services, immutable vN processors/consumers, optional pipeline labels.

### Review Rule

Engineering standards should stay boring. Add tools only when they remove real recurring complexity or protect important platform guarantees.

## Consequences

- Positive: every package starts from the same defaults; new contributors don't relitigate lint/test/build choices.
- Positive: the same checks pass locally and in CI; no environment drift.
- Negative: pinning to "boring" choices means occasional friction when a fashionable tool would have been ergonomic.
- Follow-up: revisit individual lines via per-decision MADRs as the team grows past one contributor or as a tool's maintenance status changes (e.g. dbmate replacement).
- Revisit if: the team adds a second contributor (re-evaluate workflow tooling), or a load-bearing dependency goes unmaintained.

## Pros and Cons of the Options

_n/a_
