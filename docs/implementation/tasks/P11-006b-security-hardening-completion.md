# P11-006b: Security Hardening — Completion (Wire-up + HSTS + Body Limit + OpenAPI 403)

Status: Partial — origin guard wire-up + HSTS + body-limit + OpenAPI 403 landed; rate-limit module deferred to [P11-006c](./P11-006c-rate-limit-module.md)

## Goal

Complete the P11-006 scope that the salvage partial did not cover:

1. **Wire the origin guard into the ingester's request pipeline** — the P11-006 salvage shipped the `origin/` module but did not register it with Fastify. `POST /v1/events` is currently NOT enforcing the allow-list.
2. **Ship the rate-limit module** — the worker only staged `types.ts`; no implementation landed.
3. **HSTS** — emit `Strict-Transport-Security` on production responses.
4. **Body-size limit** — wire Fastify's `bodyLimit` to `POLARIS_INGEST_MAX_BODY_BYTES` (default 1 MiB).
5. **OpenAPI updates** — document the new `403 origin_not_allowed` and `429 rate_limited` Problem responses.

## Required Reading

- [P11-006 task card](./P11-006-security-hardening.md) (parent, partial in `b8b9741`)
- [Production Readiness — Control-Plane Permissions + TLS](../../architecture/11-production-readiness.md)
- [Ingestion and SDKs](../../architecture/04-ingestion-and-sdks.md)
- `apps/ingester-api/src/app.ts` — the Fastify wiring site
- `apps/ingester-api/src/origin/` — the salvaged module to wire in
- `apps/ingester-api/src/openapi/paths.ts` — Problem-response declarations
- `apps/ingester-api/src/metrics/registry.ts` — where new metric counters live
- `apps/ingester-api/src/dedupe/redis.ts` — pattern for the Redis-backed sliding-window store

## Dependencies

- P11-006 (Partial done, origin scaffold in `b8b9741`)
- P12-002 (OpenAPI publishing in `b27d15e`)

## Write Scope

Allowed:

```text
apps/ingester-api/
docs/api/openapi.yaml
docs/api/openapi.json
```

Forbidden:

```text
packages/web-sdk/
packages/node-sdk/
processors/
consumers/
db/migrations/
```

## Implementation Notes

### 1. Origin guard wire-up

In `apps/ingester-api/src/app.ts`, the auth preHandler chain is the model. Add the origin guard as a preHandler AFTER auth (so the guard has access to `request.authContext.{projectId, source.id, environment}`) but BEFORE the ingest handler:

```ts
// pseudocode
const allowedOriginsRepo = createPostgresAllowedOriginsRepository(db);
const allowedOriginsCache = new AllowedOriginsCache({
  repository: allowedOriginsRepo,
  ttlMs: config.originCacheTtlMs ?? 60_000,
});
app.addHook("preHandler", createOriginGuardPreHandler({
  cache: allowedOriginsCache,
  metrics,
  logger,
}));
registerCorsPreflightRoute(app, { cache: allowedOriginsCache, logger });
```

Cross-origin browsers MUST get the CORS error path (missing `Access-Control-Allow-Origin` response header → browser refusal). Server-to-server callers MUST bypass the check (no `Origin` header → no enforcement).

### 2. Rate-limit module

Ship `apps/ingester-api/src/rate-limit/`:

- `types.ts` (already salvaged) — keep it
- `redis.ts` — `RedisRateLimiter` with `acquire({ apiKeyId }): Promise<{ allowed: true } | { allowed: false; retry_after_seconds: number }>`. Uses a Redis sliding window via `INCR` + `EXPIRE` on key `polaris:rl:<api_key_id>:<window_second>`. TTL = 2× window.
- `memory.ts` — `InMemoryRateLimiter` for local-dev when Redis is unset (mirrors the dedupe layer's fallback).
- `index.ts` — barrel + `createRateLimiter(config)` factory that returns the appropriate adapter.
- `guard.ts` — Fastify preHandler that increments the counter and throws `ProblemError({ status: 429, code: 'rate_limited', detail: ..., retry_after_seconds })` on refusal. On Redis unavailable, fail OPEN (same posture as dedupe); metric `polaris_ingest_rate_limit_skipped_total` increments.

Config: `POLARIS_RATE_LIMIT_PER_API_KEY_RPS` default 1000. `POLARIS_RATE_LIMIT_PROJECT_OVERRIDES` JSON map for per-project overrides (mirror the dedupe per-project window pattern).

The 429 response sets `Retry-After: <seconds>` header.

### 3. HSTS

Add a global response hook that sets `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` ONLY when `POLARIS_ENV === 'production'`. Local dev does not get it. Tests:
- production env → HSTS present.
- development env → HSTS absent.

### 4. Body-size limit

Wire Fastify's `bodyLimit` from `POLARIS_INGEST_MAX_BODY_BYTES` (default 1 MiB / 1_048_576). Fastify already returns a 413 for over-limit; the existing handler test infrastructure should already cover this — just verify the env var is plumbed.

### 5. OpenAPI updates

`apps/ingester-api/src/openapi/paths.ts` already documents Problem responses for 400/401/413/415/500/503. Add:
- 403 `origin_not_allowed` (with example response body)
- 429 `rate_limited` (with `Retry-After` response header documented + example body including `retry_after_seconds`)

Re-run `pnpm openapi` to regenerate `docs/api/openapi.{yaml,json}`; `pnpm openapi:check` should stay green.

### 6. Metrics

Two new counters land in `IngestMetrics`:
- `polaris_ingest_rate_limit_rejected_total{project_id, environment}` — already-counted refusals
- `polaris_ingest_rate_limit_skipped_total{project_id, environment}` — Redis-unavailable bypasses

The `polaris_ingest_origin_rejected_total` counter already exists (from the salvage).

## Acceptance Criteria

- [ ] `POST /v1/events` enforces the origin allow-list (cross-origin browser with disallowed origin → 403 origin_not_allowed).
- [ ] `POST /v1/events` enforces per-API-key rate limit (1001st request in a second → 429 rate_limited with `Retry-After`).
- [ ] Rate-limit fail-open path works when Redis is down (request passes; skipped metric increments).
- [ ] HSTS header present on production responses, absent on dev responses.
- [ ] Body-size limit returns 413 for over-1-MiB bodies (default; configurable).
- [ ] OpenAPI doc documents 403 origin_not_allowed + 429 rate_limited with examples.
- [ ] `pnpm openapi:check` stays green after re-generation.
- [ ] Tests cover all six acceptance points.
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm format:check` green.

## Checks

```text
pnpm typecheck
pnpm test
pnpm lint
pnpm openapi:check
```

## Handoff

```text
Files changed:
Commands run:
Checks passed:
Known gaps:
```
