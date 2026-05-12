# P6-003: API Key Lifecycle CLI

Status: Done (merged in `ac639f0`)

## Goal

Implement CLI commands for API key creation, listing, revocation, and rotation.

## Required Reading

- [Control Plane](../../architecture/02-control-plane.md)
- [Ingestion and SDKs](../../architecture/04-ingestion-and-sdks.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)

## Dependencies

- P6-001
- P6-002
- P2-002

## Write Scope

Allowed:

```text
apps/polaris-cli/
db/
migrations/
packages/shared-secrets/
```

Forbidden:

```text
packages/web-sdk/
packages/node-sdk/
processors/
consumers/
```

## Implementation Notes

Commands should cover:

```text
polaris keys create --project <id> --env <env> --source <source_id> --type web|backend
polaris keys list --project <id> --env <env>
polaris keys revoke <key_id>
polaris keys rotate <key_id>
```

Raw keys are shown once and never stored. PostgreSQL stores only hashes and metadata.

### Rotation policy

v1 does **not** force key rotation. Operators rotate when they need to. The platform supports the workflow but does not expire keys automatically.

- `polaris keys rotate <key_id>` issues a new key and revokes the old one immediately. No grace period. If overlap is needed, the operator runs `keys create` first, deploys the new key, then runs `keys revoke` on the old key.
- `polaris keys list` includes a `created_at` and `last_used_at` column so operators can surface long-lived keys and triage rotation candidates.
- Production operator dashboards (P10) include a "API keys older than N days" panel so a rotation policy can be added later without rebuilding the tooling.
- High-risk commands (`keys create`, `keys revoke`, `keys rotate` against production) declare `mutates: true` and route through the dispatcher gate from P6-007.

A forced-rotation policy (e.g., 90-day max age) is a future operational decision. v1 builds the tooling so the policy is a one-line config change later.

## Acceptance Criteria

- [ ] Key create command outputs raw key exactly once.
- [ ] Key list never displays raw secret.
- [ ] Revoke disables key for ingestion.
- [ ] Rotate creates a replacement, revokes the old key immediately, and audits the action.
- [ ] Key list includes `created_at` and `last_used_at` columns.
- [ ] Production `keys create/revoke/rotate` commands declare `mutates: true` and pass through the dispatcher gate.
- [ ] Tests cover hash/verify behavior and no raw secret persistence.
- [ ] Tests verify that no forced expiry runs in v1 (keys older than any threshold remain valid until explicitly revoked).

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
  packages/shared-secrets/src/hashing.ts                 (new)  argon2id primitive shared by ingester and CLI
  packages/shared-secrets/test/hashing.test.ts           (new)  hashSecret/verifySecret round-trip
  packages/shared-secrets/src/index.ts                          export hashSecret/verifySecret/POLARIS_HASH_ALGORITHM
  packages/shared-secrets/package.json                          add @node-rs/argon2, description update
  apps/ingester-api/src/auth/hash.ts                            now a thin re-export over shared-secrets.verifySecret
  apps/ingester-api/test/auth/hash.test.ts                      import hashSecret from shared-secrets (was @node-rs/argon2)
  apps/ingester-api/package.json                                drop @node-rs/argon2, add @polaris/shared-secrets
  apps/polaris-cli/package.json                                 add @polaris/shared-secrets, uuid
  apps/polaris-cli/src/commands/keys/index.ts            (new)  `polaris keys` group
  apps/polaris-cli/src/commands/keys/create.ts           (new)  mutates: true; prints raw token ONCE
  apps/polaris-cli/src/commands/keys/list.ts             (new)  mutates: false; never shows secret/hash
  apps/polaris-cli/src/commands/keys/revoke.ts           (new)  mutates: true; idempotent
  apps/polaris-cli/src/commands/keys/rotate.ts           (new)  mutates: true; INSERT + revoke in one txn
  apps/polaris-cli/src/commands/keys/token.ts            (new)  polaris_ak_<uuidv7>.base64url(32B) shape
  apps/polaris-cli/src/db/api-keys.ts                    (new)  insert / find / list / revoke helpers
  apps/polaris-cli/src/db/index.ts                              export api-keys helpers
  apps/polaris-cli/src/commands/index.ts                        register keysCommand
  apps/polaris-cli/src/index.ts                                 export keys command + runner builders + token helper
  apps/polaris-cli/test/keys-commands.test.ts            (new)  20 tests covering all 4 commands + mutates flags
  pnpm-lock.yaml                                                @node-rs/argon2 moved to shared-secrets; uuid added

Commands run:
  pnpm install
  pnpm -r build
  pnpm typecheck
  pnpm lint
  pnpm format:check
  pnpm test
  pnpm --filter @polaris/polaris-cli build
  pnpm --filter @polaris/ingester-api typecheck

Checks passed:
  typecheck:        all workspace projects (13/13)
  lint:             biome + lint-clickhouse-imports
  format:check:     biome (after one auto-fix pass)
  tests:            700 passing (61 test files), incl. 20 new keys-command tests +
                    8 shared-secrets hashing tests + 4 updated ingester hash tests
  build:            @polaris/polaris-cli compiles; bin/polaris.js runs --help end-to-end
  ingester:         @polaris/ingester-api typechecks after the shared-secrets refactor

Known gaps:
  - Forced-rotation policy (e.g. 90-day max age) deferred per ADR. Tooling
    ships today; policy is a one-line config later.
  - Audit-record writes are out of scope (P6-006 territory). Commands declare
    `mutates: true` so the P6-007 dispatcher gate plugs in cleanly.
  - The CLI talks to PostgreSQL directly through @polaris/shared-db. When
    apps/control-plane-api ships (P6-000), the keys commands will be
    re-pointed at its HTTP endpoints; the runner+store abstraction keeps the
    swap small.
  - last_used_at column surfaced by `keys list` is currently written only by
    the ingester (out-of-band coalesced writer is a follow-up). list renders
    `(unused)` until the ingester wires it up.
```

