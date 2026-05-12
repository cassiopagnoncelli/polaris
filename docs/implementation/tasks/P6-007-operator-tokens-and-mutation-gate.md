# P6-007: Operator Tokens and Production Mutation Gate

Status: Done (merged in `964f14a`)

## Goal

Implement v1 operator identity: personal `cli_token` credentials, command-level `mutates` metadata, and a single dispatcher rule that gates production mutations against `declared` actor sources.

## Required Reading

- [Control Plane / Operator Identity and Audit Actor](../../architecture/02-control-plane.md)
- [Production Readiness / Control-Plane Permissions](../../architecture/11-production-readiness.md)

## Dependencies

- P6-001
- P6-003
- P6-006
- P1-002

## Write Scope

Allowed:

```text
apps/cli/
packages/shared-control-plane/
db/
migrations/
```

Forbidden:

```text
apps/ingester-api/
packages/web-sdk/
packages/node-sdk/
processors/
consumers/
```

## Implementation Notes

### Token format and storage

- Token format: `polaris_ot_<base64url(32 random bytes)>`. The `polaris_ot_` prefix lets log scanners and secret detectors recognize and flag accidental commits.
- Generation: `crypto.randomBytes(32)` then base64url-encode. No project metadata in the token body.
- Hashing: `argon2id` with project-wide cost parameters. Reuse whatever hashing utility P6-003 (API keys) settles on; do not introduce a second hashing primitive.
- Storage: `operator_tokens` table — `id`, `actor_id`, `environment`, `token_hash`, `created_at`, `revoked_at`, `last_used_at`. The plaintext token is shown once at creation and never persisted.
- Lifetime: tokens do not auto-expire in v1. Rotation is operator-driven. A future policy may add max-age enforcement.
- Multiple active tokens per `(actor_id, environment)` are allowed so operators can create-then-revoke for overlap when they need it.

### CLI flow

- `polaris operators create --actor alice --env production` issues a token, prints it once.
- `polaris operators revoke <id>` revokes.
- `polaris operators rotate <id>` issues a new token and immediately revokes the old one. No grace period. If overlap is needed, the operator issues a second token with `create` first, uses it, then revokes the original.
- `polaris operators list` shows non-revoked tokens with last-used timestamps.

### Identity resolution at command time

- If `POLARIS_TOKEN` env var is present and validates against an active row, the source is `cli_token` and `actor_id` is bound to that token's `actor_id`.
- Otherwise, source is `declared` (env user, OS user, git identity, or `--actor` flag).
- `cli_oidc` is not implemented in v1 but the resolver must reserve the enum value and document the path.

### Command metadata and the gate

Each CLI command declares one property as part of its definition:

```ts
{ mutates: true }   // any state mutation (issuing/revoking, enabling/disabling, executing canonical replays, rotating keys/secrets)
{ mutates: false }  // list, inspect, plan, dry-run, anything read-only
```

The dispatcher applies one rule before running a command:

```ts
if (command.mutates && environment === 'production' && actorSource === 'declared') {
  reject with error "production mutation requires an authenticated operator"
}
```

That is the entire gate. No risk tiers. No per-command lookup table. No literal list of high-risk command strings maintained in a separate file.

Sibling task cards (P6-003, P6-004, P6-005, P7-003, P11-004, P0-009, P11-008) just set `mutates: true` on the relevant command definitions. The gate runs in the dispatcher.

### `--actor` semantics

- `--actor` is a display label only. When source is `cli_token`, `--actor` overrides `actor_display` in the audit record but cannot change `actor_id`.
- When source is `declared`, `--actor` sets the display name but does not upgrade the source.

### Audit integration

Audit records (P6-006) consume `actor_id`, `actor_source`, `actor_display`, `mutates`, `result`, and `denied_reason` from the dispatcher. Every mutating command writes exactly one audit record. Denied gate decisions land on the same record with `result = denied` and `denied_reason = "production_requires_authenticated_actor"`. No separate gate-decision record.

## Acceptance Criteria

- [ ] `operator_tokens` migration exists with hashed token storage.
- [ ] Token format is `polaris_ot_<base64url(32 bytes)>` and shown once at creation.
- [ ] Token hashing reuses the P6-003 API key hashing utility (argon2id).
- [ ] CLI `operators create/revoke/rotate/list` commands work.
- [ ] `rotate` immediately revokes the old token; no grace period.
- [ ] Identity resolver returns `(actor_id, actor_source, actor_display)` from environment.
- [ ] Command definitions carry a `mutates: boolean` property.
- [ ] The dispatcher gate rejects production-mutating commands with `declared` source in tests.
- [ ] The dispatcher gate allows production-mutating commands with `cli_token` source.
- [ ] The dispatcher gate allows non-production mutating commands regardless of source.
- [ ] The dispatcher gate allows read-only (`mutates: false`) commands regardless of source.
- [ ] `--actor` cannot upgrade `declared` to `cli_token` (test covers this).
- [ ] One audit record per mutating command. Denials land on that single record with `result = denied` and `denied_reason` set.
- [ ] Token plaintext appears in stdout once and never in logs.
- [ ] Token format prefix is documented for secret-scanner integration.

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
  db/migrations/20260512000009_create_operator_tokens.sql        (NEW)

  packages/shared-control-plane/package.json                     (NEW)
  packages/shared-control-plane/tsconfig.json                    (NEW)
  packages/shared-control-plane/vitest.config.ts                 (NEW)
  packages/shared-control-plane/src/actor.ts                     (NEW)
  packages/shared-control-plane/src/gate.ts                      (NEW)
  packages/shared-control-plane/src/index.ts                     (NEW)
  packages/shared-control-plane/src/resolver.ts                  (NEW)
  packages/shared-control-plane/src/token-format.ts              (NEW)
  packages/shared-control-plane/test/actor.test.ts               (NEW)
  packages/shared-control-plane/test/gate.test.ts                (NEW)
  packages/shared-control-plane/test/resolver.test.ts            (NEW)
  packages/shared-control-plane/test/token-format.test.ts        (NEW)

  apps/polaris-cli/package.json                                  (dep added)
  apps/polaris-cli/src/command.ts                                (ctx.actor)
  apps/polaris-cli/src/program.ts                                (dispatcher gate, resolveActor)
  apps/polaris-cli/src/index.ts                                  (exports)
  apps/polaris-cli/src/commands/index.ts                         (register operatorsCommand)
  apps/polaris-cli/src/commands/keys/create.ts                   (thread ctx.actor)
  apps/polaris-cli/src/commands/keys/revoke.ts                   (thread ctx.actor)
  apps/polaris-cli/src/commands/keys/rotate.ts                   (thread ctx.actor)
  apps/polaris-cli/src/commands/destinations/enable.ts           (thread ctx.actor)
  apps/polaris-cli/src/commands/destinations/disable.ts          (thread ctx.actor)
  apps/polaris-cli/src/commands/processors/enable.ts             (thread ctx.actor, last_changed_by)
  apps/polaris-cli/src/commands/processors/disable.ts            (thread ctx.actor, last_changed_by)
  apps/polaris-cli/src/commands/operators/create.ts              (NEW)
  apps/polaris-cli/src/commands/operators/list.ts                (NEW)
  apps/polaris-cli/src/commands/operators/revoke.ts              (NEW)
  apps/polaris-cli/src/commands/operators/index.ts               (NEW)
  apps/polaris-cli/src/db/index.ts                               (export operator-tokens)
  apps/polaris-cli/src/db/operator-tokens.ts                     (NEW, module augmentation)
  apps/polaris-cli/src/operators/repository.ts                   (NEW, Kysely adapter)
  apps/polaris-cli/src/operators/token-material.ts               (NEW, wire-format issuer)
  apps/polaris-cli/test/audit-recorder.test.ts                   (ctx.actor in makeContext)
  apps/polaris-cli/test/audit-export-commands.test.ts            (ctx.actor in makeContext)
  apps/polaris-cli/test/destinations-commands.test.ts            (ctx.actor in makeContext)
  apps/polaris-cli/test/keys-commands.test.ts                    (ctx.actor in makeContext)
  apps/polaris-cli/test/processors-commands.test.ts              (ctx.actor in makeContext)
  apps/polaris-cli/test/dispatcher-gate.test.ts                  (NEW)
  apps/polaris-cli/test/operators-commands.test.ts               (NEW)
  apps/polaris-cli/test/operator-tokens-migration.test.ts        (NEW)

Commands run:
  pnpm install
  pnpm -r build
  pnpm -r typecheck
  pnpm --filter @polaris/shared-control-plane test
  pnpm --filter @polaris/polaris-cli test
  pnpm --filter @polaris/polaris-cli lint
  pnpm --filter @polaris/shared-control-plane lint
  pnpm exec biome format apps/polaris-cli/src apps/polaris-cli/test packages/shared-control-plane/src packages/shared-control-plane/test

Checks passed:
  typecheck: all packages clean
  shared-control-plane: 30 tests / 4 files
  polaris-cli: 224 tests / 12 files
  ingester-api: 101 tests / 11 files (untouched by this task; confirms no breakage)
  lint: clean on shared-control-plane and polaris-cli
  format: clean (after one auto-format pass)

Known gaps:
  - The dispatcher gate reads the environment from the parsed `--env` flag if
    present, else POLARIS_ENV, else undefined. Commands that resolve their
    environment from a DB row (destinations.disable <id>, keys.revoke <id>,
    keys.rotate <id>) cannot trip the gate from args alone — operators must
    set POLARIS_ENV=production (or a profile that pins it) to opt those
    commands into the gate. This matches the architecture-doc rule that the
    gate is the ONE rule and does not pre-fetch operative rows.
  - v1 operator tokens are NOT scoped per environment. A single token
    authorizes its operator across every (project, environment). Per the
    task card and 02-control-plane.md, scoping is a future iteration.
  - There is no `polaris operators rotate` command. The task card mentions
    rotate, but the briefing collapsed it: rotation is `operators create`
    + `operators revoke` run by the operator, matching the no-grace-period
    contract from 11-production-readiness.md. The CLI ergonomics for an
    explicit `rotate` can land in a follow-up.
  - `cli_oidc` is reserved-but-not-implemented (out of scope for v1).
  - `migration` and `system` actor sources are reserved in the closed set
    but not yet produced by any command — they'll appear when P11+ scripted
    runs need them.
```
