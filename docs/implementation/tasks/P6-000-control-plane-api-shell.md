# P6-000: Control-Plane API Shell

Status: Done

## Goal

Create the `apps/control-plane-api/` Fastify service shell with config, logging, health/readiness, RFC 7807 Problem Details, OpenAPI hook, bearer-token authentication against `operator_tokens`, and the dispatcher gate that rejects production mutations from `declared` actor sources. No business endpoints are implemented in this task — those land in P6-002 onward.

## Required Reading

- [Control Plane / CLI-First Control Plane](../../architecture/02-control-plane.md)
- [Control Plane / Operator Identity and Audit Actor](../../architecture/02-control-plane.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)

## Dependencies

- P0-003
- P0-004
- P0-005
- P1-002
- P6-007

## Write Scope

Allowed:

```text
apps/control-plane-api/
package.json
pnpm-workspace.yaml
```

Forbidden:

```text
apps/ingester-api/
apps/polaris-cli/
processors/
consumers/
packages/web-sdk/
packages/node-sdk/
```

## Implementation Notes

### Service shell

- Use Fastify with the shared service bootstrap (P0-005).
- Same Pino logger config, same request-ID hook, same Problem Details error handler, same health/readiness routes, same OpenAPI generation as the ingester.
- Listen on a separate port from the ingester. Service is deployed independently.

### Authentication hook

Register a request hook that runs before route handlers:

```text
1. Read Authorization: Bearer <token> header.
2. Validate the token against operator_tokens (hashed lookup).
3. If valid, attach (actor_id, actor_source = 'cli_token', actor_display) to the request context.
4. If absent, attach actor_source = 'declared' with whatever display info the request supplied (X-Polaris-Actor header, e.g.).
5. If the token is present but invalid, return Problem Details with status 401 and code "invalid_operator_token".
```

The hook never logs the token plaintext.

### Dispatcher gate

Each route declares `mutates: boolean` in its schema/metadata. Add a hook that runs after authentication:

```ts
if (route.mutates && env === 'production' && request.actor_source === 'declared') {
  return reply.problemDetails(403, "production_requires_authenticated_actor", ...)
}
```

The gate is implemented once at the framework level; routes don't reimplement it. See P6-007 for the canonical rule.

### Audit hook

Every mutating route writes one audit record after the handler completes (success or failure). The audit record includes `actor_id`, `actor_source`, `actor_display`, `mutates`, `result`, `denied_reason` (null when allowed), `command` (route name), `arguments_redacted`, and `correlation_id`. Audit writes never include credentials.

### Routes scaffolded in this task

Only the minimum to prove the shell:

- `GET /health` — liveness
- `GET /ready` — readiness, checks PostgreSQL connectivity
- `GET /version` — build metadata, requires no auth
- `GET /v1/whoami` — returns `(actor_id, actor_source)` after auth hook; useful for CLI debugging

Business routes (keys, sources, destinations, replays) are added in subsequent P6 tasks.

### OpenAPI

Generate OpenAPI from Fastify route schemas as required by engineering standards.

## Acceptance Criteria

- [x] Service starts locally.
- [x] Health, readiness, version routes exist.
- [x] Bearer-token auth hook validates against `operator_tokens` and attaches actor context.
- [x] Routes carry a `mutates` flag; the dispatcher gate rejects production mutations with `declared` source.
- [x] `whoami` returns the resolved actor context after auth.
- [x] Audit hook writes one record per mutating request (proven with a single sample mutating test route that exists only in tests).
- [x] Errors use RFC 7807 Problem Details.
- [x] OpenAPI generation hook or route exists.
- [x] No token plaintext appears in any log line.

## Checks

Run where possible:

```text
pnpm typecheck
pnpm test
pnpm lint
pnpm --filter control-plane-api build
```

## Handoff

```text
Files changed:
  apps/control-plane-api/                                              new package
    package.json, tsconfig.json, vitest.config.ts
    src/app.ts, server.ts, index.ts, config.ts
    src/auth/bearer.ts        Authorization: Bearer hook → ResolvedActor
    src/auth/gate.ts          enforceProductionMutationGate wrapper
    src/audit/recorder.ts     AuditRecorder + Kysely + InMemory adapters
    src/metrics/registry.ts   ControlPlaneMetrics shell
    src/openapi/setup.ts      NOOP_OPENAPI_SETUP placeholder
    src/operators/repository.ts  OperatorTokenRepository Kysely adapter
    src/routes/whoami.ts      GET /v1/whoami
    test/app.test.ts          8 behavioral tests
  docs/implementation/kanban.md                                        P6-000 Ready → Done
  docs/implementation/tasks/P6-000-control-plane-api-shell.md          Status: Done + AC

Commands run:
  pnpm install
  pnpm --filter @polaris/control-plane-api typecheck
  pnpm --filter @polaris/control-plane-api test
  pnpm typecheck                                          workspace; clean
  pnpm lint, format:check, test                           clean (1574 + 59 passing)

Checks passed:
  typecheck, lint, format:check, test

Known gaps:
  - Business routes deferred to P6-002+ (the shell exists; routes plug
    into the gate factory).
  - OperatorTokensTable + AuditRecordsTable typed augmentations are
    duplicated with apps/polaris-cli. Future cleanup hoists to
    @polaris/shared-control-plane.
  - Audit recorder is not yet a global onResponse hook — each route's
    handler calls it explicitly (the test demonstrates the pattern).
  - OpenAPI document is the no-op shape; first business route lands
    a real schema.
```
