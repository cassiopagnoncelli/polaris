# P2-001: Ingester API Shell

Status: Backlog

## Goal

Create the Fastify ingester service shell with config, logging, health/readiness, Problem Details, OpenAPI hook, and no ingestion behavior yet.

## Required Reading

- [Ingestion and SDKs](../../architecture/04-ingestion-and-sdks.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)
- [Claude Instructions](../../instructions/claude.md)

## Dependencies

- P0-003
- P0-004
- P0-005

## Write Scope

Allowed:

```text
apps/ingester-api/
package.json
pnpm-workspace.yaml
```

Forbidden:

```text
packages/shared-schemas/
packages/shared-kafka/
processors/
consumers/
```

## Implementation Notes

- Use Fastify.
- Use shared config/logger/service bootstrap packages.
- Add health/readiness.
- Add request IDs.
- Do not publish to Redpanda in this task.
- Do not implement enrichment.

## Acceptance Criteria

- [ ] Ingester service starts locally.
- [ ] Health endpoint exists.
- [ ] Readiness endpoint exists.
- [ ] Request-level errors use Problem Details.
- [ ] OpenAPI generation hook or route exists.

## Checks

Run where possible:

```text
pnpm typecheck
pnpm test
pnpm lint
pnpm --filter ingester-api build
```

## Handoff

```text
Files changed:
  apps/ingester-api/package.json
  apps/ingester-api/tsconfig.json
  apps/ingester-api/vitest.config.ts
  apps/ingester-api/src/index.ts
  apps/ingester-api/src/server.ts
  apps/ingester-api/src/app.ts
  apps/ingester-api/src/config.ts
  apps/ingester-api/src/routes/events.ts
  apps/ingester-api/test/app.test.ts
  apps/ingester-api/test/config.test.ts
  pnpm-lock.yaml (regenerated for the new workspace)

Commands run:
  pnpm install
  pnpm build
  pnpm typecheck
  pnpm lint
  pnpm format:check
  pnpm test
  pnpm --filter @polaris/ingester-api build
  Manual HTTP smoke: GET /health, GET /ready, POST /v1/events, SIGTERM drain

Checks passed:
  typecheck (all 10 workspace projects)
  biome lint (168 files, no findings)
  biome format check (168 files, no diffs)
  vitest (39 files, 449 tests, including 12 new ingester tests)
  ingester-api build emits dist/server.js, dist/app.js, dist/routes/events.js
  Binary boots, serves /health 200, /ready 200, /v1/events 501 not_implemented,
    and exits 0 on SIGTERM with full graceful drain logs

Known gaps:
  - No API key authentication, no envelope/properties validation, no Redpanda
    publish, no Redis dedupe. Those land in P2-002 and P2-003 — the route
    handler intentionally throws ProblemError("not_implemented").
  - OpenAPI hook is wired but the concrete @fastify/swagger + Zod-type-provider
    integration is opt-in; the shell ships with the NOOP_OPENAPI_SETUP default
    so the service can start in CI without those plugins. Production OpenAPI
    publishing comes through P12-002.
  - Readiness probes array is empty — the shell has no external dependencies
    yet. P2-002 adds the PostgreSQL probe, P2-003 adds Redpanda and Redis.
  - No Dockerfile yet (P11-001 owns production image packaging).
```

