# P0-003: Shared Config Package

Status: Backlog

## Goal

Create a shared Zod-validated runtime configuration package.

## Required Reading

- [Engineering Standards](../../architecture/09-engineering-standards.md)
- [Control Plane](../../architecture/02-control-plane.md)
- [Claude Instructions](../../instructions/claude.md)

## Dependencies

- P0-001
- P0-002

## Write Scope

Allowed:

```text
packages/shared-config/
package.json
pnpm-workspace.yaml
```

Forbidden:

```text
apps/
processors/
consumers/
packages/shared-logger/
packages/shared-kafka/
```

## Implementation Notes

- Services should not read `process.env` ad hoc outside this package.
- Use Zod for runtime config schemas.
- Support `.env` for local development if the implementation chooses a small maintained helper.
- Keep the API small and documented.

## Acceptance Criteria

- [ ] `packages/shared-config` exists.
- [ ] It exports a typed config loader.
- [ ] Invalid config fails fast.
- [ ] Unit tests cover success and failure cases.

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
- packages/shared-config/package.json (new): @polaris/shared-config workspace package, ESM-only, runtime deps zod 4.4.3 + dotenv 17.4.2, devDeps mirror the workspace baseline (Biome 2.4.15, TypeScript 6.0.3, Vitest 4.1.6, @types/node 22.19.19, rimraf 6.0.1). Exports root and ./schemas subpath. Scripts: build, clean, typecheck, lint, format, test, test:watch.
- packages/shared-config/tsconfig.json (new): extends ../../tsconfig.base.json, rootDir src, outDir dist, types: ["node"], excludes test/ and *.test.ts from emit.
- packages/shared-config/vitest.config.ts (new): local Vitest config so `pnpm --filter shared-config test` picks up files under test/ and src/ inside the package directory (the root config globs the whole workspace, which finds nothing when scoped to a single package).
- packages/shared-config/src/index.ts (new): public surface re-export — errors, env helpers, loader, all schemas. Top-of-file docblock shows the typical service usage pattern.
- packages/shared-config/src/errors.ts (new): ConfigValidationError class. Carries serviceName, raw issues array (path/message/code), and a multi-line human-readable message that names the service and every invalid field. Thrown by loadConfig on schema rejection so services crash with an obviously-failed-config signal.
- packages/shared-config/src/env.ts (new): EnvSource type plus loadEnv/readEnv/pickEnv. loadEnv merges process env over zero or more .env files using dotenv.parse(); precedence is process env > earlier file > later file. Missing files are silently skipped. Empty strings are treated as undefined so Zod defaults can kick in.
- packages/shared-config/src/loader.ts (new): loadConfig (the one entry point services call), composeConfigSchema (builds a namespaced schema from multiple flat-env sub-schemas), and loadConfigWithDefaults (auto-loads .env.{POLARIS_ENV}.local, .env.local, .env.{POLARIS_ENV}, .env in that priority order; env-suffixed files are skipped when POLARIS_ENV is unset to avoid silently loading .env.production on dev boxes).
- packages/shared-config/src/schemas/common.ts (new): shared Zod fragments — environmentSchema (local/development/staging/production), logLevelSchema, portSchema (coerced 1..65535), booleanFromStringSchema (true/false/1/0/yes/no/on/off, case-insensitive), csvListSchema (trim/drop-empty), nonEmptyStringSchema, positiveIntSchema, nonNegativeIntSchema, durationMsSchema.
- packages/shared-config/src/schemas/service.ts (new): serviceEnvSchema — POLARIS_SERVICE_NAME (required), POLARIS_SERVICE_VERSION ("0.0.0"), POLARIS_ENV (required), POLARIS_LOG_LEVEL ("info"), POLARIS_LOG_PRETTY (defaults true for local, false otherwise), POLARIS_GIT_SHA, POLARIS_BUILD_TIME. Transforms to ServiceConfig.
- packages/shared-config/src/schemas/postgres.ts (new): postgresEnvSchema for the Kysely-backed control-plane connection — host/db/user/password required, sensible defaults for port (5432), ssl, poolMax (10), connect/idle timeouts.
- packages/shared-config/src/schemas/redis.ts (new): redisEnvSchema — host required, port (6379), db (0..15), optional username/password/keyPrefix, connectTimeoutMs (5000).
- packages/shared-config/src/schemas/redpanda.ts (new): redpandaEnvSchema — comma-separated POLARIS_REDPANDA_BROKERS (>= 1), clientId required, optional SASL block (plain/scram-sha-256/scram-sha-512). superRefine enforces "all-or-nothing" SASL credentials.
- packages/shared-config/src/schemas/clickhouse.ts (new): clickhouseEnvSchema — http(s) URL validation, required service credentials (polaris_service role), optional operator credentials (polaris_operator) with all-or-nothing validation. Matches the access-model split in docs/architecture/07-clickhouse.md.
- packages/shared-config/src/schemas/http.ts (new): httpEnvSchema for Fastify-backed services — host ("0.0.0.0"), port (3000), bodyLimitBytes (1 MiB), request/keep-alive timeouts.
- packages/shared-config/src/schemas/index.ts (new): re-exports every schema module.
- packages/shared-config/test/env.test.ts (new): 10 tests — readEnv/pickEnv behavior, loadEnv precedence (process > .env.local > .env), missing files, frozen result.
- packages/shared-config/test/schemas.test.ts (new): 29 tests — every shared schema's happy path, defaults, coercion, and rejection cases (port range, broker list, ClickHouse URL scheme, half-set operator credentials, SASL pairing, etc.).
- packages/shared-config/test/loader.test.ts (new): 8 tests — loadConfig success/failure, ConfigValidationError content, composeConfigSchema, loadConfigWithDefaults priority order, env-suffix safety when POLARIS_ENV is unset.
- pnpm-workspace.yaml: unchanged (write scope listed it but the existing globs already match packages/*).
- pnpm-lock.yaml: regenerated by `pnpm install` to add zod 4.4.3, dotenv 17.4.2, rimraf 6.0.1 transitive deps for the new package (the task notes that the integration step regenerates the lockfile anyway).

Commands run:
- pnpm install                                        -> PASS (resolved 127, added 90)
- pnpm --filter @polaris/shared-config typecheck      -> PASS
- pnpm --filter @polaris/shared-config build          -> PASS (emits dist/ with .js, .d.ts, source maps)
- pnpm --filter @polaris/shared-config test           -> PASS (47/47, 3 files)
- pnpm --filter @polaris/shared-config lint           -> PASS
- pnpm typecheck                                       -> PASS (root tsc + recursive package typecheck)
- pnpm lint                                            -> PASS (Biome over 23 files, 0 findings)
- pnpm format:check                                    -> PASS (Biome format, 0 findings)
- pnpm test                                            -> PASS (47/47 from root vitest run)

Checks passed:
- All four task-card checks (pnpm typecheck, pnpm test, pnpm lint) pass.
- The build script requested in the worker prompt (pnpm --filter shared-config build) also passes and produces dist/.

Known gaps:
- Worker had to rebase the worktree onto main before starting because P0-002's TypeScript tooling baseline commit had not yet been merged into the worktree branch when it was created (the prompt asserted P0-002 was already in the base). After the rebase, tsconfig.base.json/tsconfig.json/biome.json/vitest.config.ts/pnpm-lock.yaml from commit 3590b97 are present and unchanged.
- The package intentionally ships no service-specific composed schema; services compose their own using `composeConfigSchema({ service, postgres, ... })`. The exemplar lives in test/loader.test.ts only.
- The optional secret-manager indirection from docs/architecture/02-control-plane.md is not wired here; P0-008 (shared-secrets) owns provider lookup. shared-config reads passwords from env directly in v1 on the assumption that secret-manager adapters resolve refs into env vars before the service boots.
- Biome's `useLiteralKeys` rule was suppressed on exactly one line in loader.ts where strict TS (`noPropertyAccessFromIndexSignature: true`) requires `env["POLARIS_ENV"]` indexed access on NodeJS.ProcessEnv.
- README/usage docs are intentionally omitted (worker prompt forbids creating .md files unless explicitly requested); usage examples live in the index.ts docblock and the test files.
```

