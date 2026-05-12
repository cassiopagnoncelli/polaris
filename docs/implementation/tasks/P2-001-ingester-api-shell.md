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
Commands run:
Checks passed:
Known gaps:
```

