# P6-000: Control-Plane API Shell

Status: Backlog

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

- [ ] Service starts locally.
- [ ] Health, readiness, version routes exist.
- [ ] Bearer-token auth hook validates against `operator_tokens` and attaches actor context.
- [ ] Routes carry a `mutates` flag; the dispatcher gate rejects production mutations with `declared` source.
- [ ] `whoami` returns the resolved actor context after auth.
- [ ] Audit hook writes one record per mutating request (proven with a single sample mutating test route that exists only in tests).
- [ ] Errors use RFC 7807 Problem Details.
- [ ] OpenAPI generation hook or route exists.
- [ ] No token plaintext appears in any log line.

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
Commands run:
Checks passed:
Known gaps:
```
