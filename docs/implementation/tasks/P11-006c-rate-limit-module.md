# P11-006c: Rate-Limit Module for the Ingester

Status: Ready

## Goal

Ship the Redis-backed sliding-window rate limiter that P11-006b deferred. The origin allow-list, HSTS header, body-size limit plumbing, and OpenAPI 403 documentation all landed in P11-006b (`<TBD-merge-sha>`); this task fills in the last security-hardening bucket per `docs/architecture/11-production-readiness.md`.

## Required Reading

- [P11-006 (parent, partial)](./P11-006-security-hardening.md)
- [P11-006b (origin guard wire-up + HSTS + body limit)](./P11-006b-security-hardening-completion.md) — the immediately preceding follow-up
- [Production Readiness — Rate Limits](../../architecture/11-production-readiness.md)
- [Ingestion and SDKs](../../architecture/04-ingestion-and-sdks.md)
- `apps/ingester-api/src/dedupe/redis.ts` — the Redis pattern to mirror (SET NX EX + fail-open on outage)
- `apps/ingester-api/src/origin/guard.ts` — the preHandler pattern P11-006b uses; rate-limit follows the same shape
- `apps/ingester-api/src/openapi/paths.ts` — where the 429 Problem response declaration lands

## Dependencies

- P11-006b (origin guard wire-up + HSTS landed)

## Write Scope

Allowed:

```text
apps/ingester-api/src/rate-limit/
apps/ingester-api/src/app.ts
apps/ingester-api/src/routes/events.ts
apps/ingester-api/src/openapi/paths.ts
apps/ingester-api/test/rate-limit/
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
apps/polaris-cli/
```

## Implementation Notes

### Surface

- `apps/ingester-api/src/rate-limit/`
  - `types.ts` — `RateLimitDecision = { allowed: true } | { allowed: false, retry_after_seconds: number }`, plus `RateLimiter` interface (`acquire({ apiKeyId, projectId, environment }): Promise<RateLimitDecision>`).
  - `redis.ts` — `createRedisRateLimiter({ redis, perSecond, windowSeconds = 1 })`. Uses `INCR` + `EXPIRE` on key `polaris:rl:<api_key_id>:<floor(now/window)>`. Fail-open on Redis error; increment `polaris_ingest_rate_limit_skipped_total{project_id, environment}`.
  - `memory.ts` — `InMemoryRateLimiter` for tests + local dev when Redis is unset.
  - `index.ts` — barrel + `createRateLimiter(config)` factory dispatching on env shape.
  - `guard.ts` — Fastify preHandler that calls `rateLimiter.acquire(...)`, increments `polaris_ingest_rate_limit_rejected_total` on refusal, sets `Retry-After: <seconds>` header, and throws `ProblemError({ status: 429, code: 'rate_limited', detail: ..., retry_after_seconds })`.

### IngestMetrics extension

In `apps/ingester-api/src/metrics/registry.ts`:

```ts
export const METRIC_INGEST_RATE_LIMIT_REJECTED_TOTAL = "polaris_ingest_rate_limit_rejected_total";
export const METRIC_INGEST_RATE_LIMIT_SKIPPED_TOTAL = "polaris_ingest_rate_limit_skipped_total";

export interface RateLimitLabels {
  readonly project_id: string;
  readonly environment: string;
}

class IngestMetrics {
  // ...existing
  incrementRateLimitRejected(labels: RateLimitLabels): void { ... }
  incrementRateLimitSkipped(labels: RateLimitLabels): void { ... }
}
```

### Wire-up in `app.ts`

The rate-limit preHandler runs AFTER `authPreHandler` (so `request.auth.{projectId, environment}` is populated) but BEFORE `originPreHandler` (a refused-by-rate-limit request should not even be checked against the allow-list; the cheaper check fires first). Extend `RegisterEventsRoutesOptions` with `rateLimitPreHandler?` and have the route's `preHandler` array order them: `[auth, rateLimit, origin]`.

Production posture: 1000 req/s per `api_key_id`, configurable via `POLARIS_RATE_LIMIT_PER_API_KEY_RPS`. Per-project overrides through `POLARIS_RATE_LIMIT_PROJECT_OVERRIDES` JSON map (same shape as the dedupe per-project window overrides from P2-003).

### OpenAPI

Add a `429 rate_limited` Problem response declaration in `paths.ts` with a `Retry-After` response header documented in the example. Regenerate `docs/api/openapi.{yaml,json}`; `pnpm openapi:check` must stay green.

### Tests

- `apps/ingester-api/test/rate-limit/redis.test.ts` — counter increments, TTL, window roll-over.
- `apps/ingester-api/test/rate-limit/memory.test.ts` — same shape against the in-memory adapter.
- `apps/ingester-api/test/rate-limit/wire-up.test.ts` — integration:
  - 1001st request in a second → 429 with `Retry-After` header.
  - Redis-down fail-open path → request passes; `polaris_ingest_rate_limit_skipped_total` increments.
  - Per-project override honored.

## Acceptance Criteria

- [ ] `apps/ingester-api/src/rate-limit/` module ships with Redis-backed + in-memory adapters.
- [ ] Rate-limit preHandler runs after auth and before origin guard.
- [ ] Refused requests return HTTP 429 `rate_limited` with `Retry-After`.
- [ ] Redis-down path fails OPEN (mirrors dedupe posture).
- [ ] `POLARIS_RATE_LIMIT_PER_API_KEY_RPS` + per-project overrides wired.
- [ ] OpenAPI 429 Problem response documented; `pnpm openapi:check` green.
- [ ] Tests cover counter behavior + wire-up integration.
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm format:check` green.

## Checks

```text
pnpm typecheck
pnpm --filter @polaris/ingester-api test
pnpm openapi:check
pnpm lint
```

## Handoff

```text
Files changed:
Commands run:
Checks passed:
Known gaps:
```
