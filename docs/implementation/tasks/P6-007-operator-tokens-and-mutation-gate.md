# P6-007: Operator Tokens and Production Mutation Gate

Status: Backlog

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
Commands run:
Checks passed:
Known gaps:
```
