# P0-005: Shared Errors and Service Bootstrap

Status: Backlog

## Goal

Create a thin shared Fastify service bootstrap package for common service concerns.

## Required Reading

- [Engineering Standards](../../architecture/09-engineering-standards.md)
- [Observability and Operations](../../architecture/08-observability-and-operations.md)
- [Ingestion and SDKs](../../architecture/04-ingestion-and-sdks.md)

## Dependencies

- P0-003
- P0-004

## Write Scope

Allowed:

```text
packages/shared-service-bootstrap/
package.json
pnpm-workspace.yaml
```

Forbidden:

```text
apps/ingester-api/
processors/
consumers/
```

## Implementation Notes

- Keep this thin. Do not build a heavy internal framework.
- Standardize request IDs, Problem Details errors, health/readiness, metrics hook shape, OpenAPI setup hook, and graceful shutdown helpers.
- It is acceptable to leave metrics/OpenAPI as integration hooks if the concrete service does not exist yet.

## Acceptance Criteria

- [ ] Shared service package exists.
- [ ] Exports Problem Details error helpers.
- [ ] Exports a Fastify bootstrap helper or plugin setup function.
- [ ] Includes tests for Problem Details serialization.

## Checks

Run where possible:

```text
pnpm typecheck
pnpm test
pnpm lint
```

## Handoff

```text
Files changed:
  packages/shared-service-bootstrap/                                      new package @polaris/shared-service-bootstrap
    README.md
    package.json
    tsconfig.json (extends ../../tsconfig.base.json)
    vitest.config.ts
    src/index.ts
    src/bootstrap/{index,service,health,metrics,error-handler,request-id,request-id-hook,shutdown,openapi}.ts
    src/problem/{index,problem,types,error}.ts
    test/{bootstrap,problem,request-id}.test.ts

Commands run:
  pnpm install
  pnpm typecheck                            PASS
  pnpm lint                                 PASS (warnings only, no errors)
  pnpm format:check                         PASS
  pnpm test                                 PASS (48 tests)
  pnpm --filter @polaris/shared-service-bootstrap build  PASS

Checks passed:
  - Thin Fastify bootstrap composed from @polaris/shared-config and @polaris/shared-logger via workspace:* deps.
  - Request-ID hook generates UUIDv7 per request and attaches it to the child logger.
  - RFC 7807 Problem Details error handler with stable `code` and `request_id` fields.
  - /health and /ready route helpers; /metrics endpoint stub registered.
  - OpenAPI generation hook via Fastify route schemas.
  - Graceful shutdown helper with signal hook + timeout.

Known gaps:
  - Background agent stalled on the stream watchdog while finalizing this handoff; work was complete and clean (all checks green).
  - Prometheus metric format hook is a stub; actual metric content comes in P10-002.
```

