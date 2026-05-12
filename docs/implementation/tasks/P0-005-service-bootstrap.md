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
packages/shared-service/
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
Commands run:
Checks passed:
Known gaps:
```

