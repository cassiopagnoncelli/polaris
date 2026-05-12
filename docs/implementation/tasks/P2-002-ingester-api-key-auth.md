# P2-002: Ingester API Key Auth

Status: Done

## Goal

Add source-scoped API key authentication to the ingester.

## Required Reading

- [Control Plane](../../architecture/02-control-plane.md)
- [Ingestion and SDKs](../../architecture/04-ingestion-and-sdks.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)

## Dependencies

- P1-002
- P2-001

## Write Scope

Allowed:

```text
apps/ingester-api/
packages/shared-config/
packages/shared-logger/
db/
migrations/
```

Forbidden:

```text
packages/web-sdk/
packages/node-sdk/
processors/
consumers/
```

## Implementation Notes

- API keys are bound to project, environment, source ID, and source type.
- Raw key values are not stored.
- Frontend keys are publishable write keys.
- Backend keys are secret server-side keys.
- Ingester stamps trusted metadata from the key.

## Acceptance Criteria

- [x] Auth middleware exists. (`apps/ingester-api/src/auth/plugin.ts` `preHandler` registered on `POST /v1/events` in `apps/ingester-api/src/routes/events.ts`.)
- [x] Invalid/revoked/missing key returns Problem Details. (`401 missing_api_key` / `401 invalid_api_key` / `503 auth_unavailable` via `@polaris/shared-service-bootstrap` `ProblemError`; integration tests in `test/auth/plugin.test.ts`.)
- [x] Valid key resolves project/environment/source context. (Attached to `request.auth` as `AuthenticatedRequestContext`; the trusted tuple is also bound onto the request logger.)
- [x] Tests cover valid and invalid key behavior. (`test/auth/api-key.test.ts`, `cache.test.ts`, `hash.test.ts`, `service.test.ts`, `plugin.test.ts` — 34 tests total.)

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
  db/migrations/20260512000002_create_api_keys.sql            (new — api_keys table)
  packages/shared-db/src/database.ts                          (Database now exposes ApiKeyTable)
  apps/ingester-api/package.json                              (+@node-rs/argon2, +shared-db, +kysely, +zod)
  apps/ingester-api/src/config.ts                             (+postgres + authCache sub-configs)
  apps/ingester-api/src/app.ts                                (wires DB, cache, auth preHandler)
  apps/ingester-api/src/index.ts                              (re-exports auth surface)
  apps/ingester-api/src/routes/events.ts                      (requires authPreHandler; 501 now `not_implemented_after_auth`)
  apps/ingester-api/src/auth/api-key.ts                       (new — header parsing + AuthenticatedRequestContext)
  apps/ingester-api/src/auth/hash.ts                          (new — argon2id verify wrapper)
  apps/ingester-api/src/auth/repository.ts                    (new — Kysely repository over api_keys)
  apps/ingester-api/src/auth/cache.ts                         (new — in-memory LRU+TTL)
  apps/ingester-api/src/auth/errors.ts                        (new — AUTH_PROBLEM_CODES catalog)
  apps/ingester-api/src/auth/service.ts                       (new — parse -> lookup -> verify)
  apps/ingester-api/src/auth/plugin.ts                        (new — Fastify preHandler hook)
  apps/ingester-api/src/auth/index.ts                         (barrel)
  apps/ingester-api/test/fixtures.ts                          (shared testConfig + InMemoryApiKeyRepository)
  apps/ingester-api/test/app.test.ts                          (updated for auth-gated route)
  apps/ingester-api/test/config.test.ts                       (covers postgres + authCache env)
  apps/ingester-api/test/auth/{api-key,cache,hash,service,plugin}.test.ts (new — 34 unit tests)

Commands run:
  git rebase main                                             (brought in 412c7b2, fd54203, de6dea4)
  pnpm install
  pnpm build
  pnpm typecheck
  pnpm lint
  pnpm format:check
  pnpm test
  pnpm --filter @polaris/ingester-api build

Checks passed:
  pnpm typecheck   OK   (12 packages)
  pnpm lint        OK   (Biome, 217 files)
  pnpm format:check OK
  pnpm test        OK   (51 files, 575 tests including 34 new auth tests)
  pnpm --filter @polaris/ingester-api build OK

Known gaps:
  - argon2id verify lives at apps/ingester-api/src/auth/hash.ts. P6-003 will
    add the issuance side; when it does it should EXTRACT this file into
    packages/shared-secrets (or a sibling) so the ingester and the CLI share
    one primitive. The current home is inside the app because P2-002's write
    scope does not include packages/shared-secrets/.
  - last_used_at is intentionally not updated in this task. Updating it on
    every request would put a synchronous write on the auth hot path; a
    coalesced out-of-band updater is a P6-003 follow-up.
  - The in-process cache is per-pod. Redis-backed caching and cross-pod
    invalidation are explicitly deferred per docs/architecture/02-control-plane.md
    "Redis Role".
  - The 501 body for `POST /v1/events` now carries code
    `not_implemented_after_auth` (a distinct code from the shell's
    `not_implemented`) so P2-003 can drop in the batch handler in place
    without changing the preHandler wiring.
  - `NOT_IMPLEMENTED_CODE` is preserved as a deprecated alias for the new
    code so existing external imports do not break.
```

