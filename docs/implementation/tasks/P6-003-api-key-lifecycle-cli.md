# P6-003: API Key Lifecycle CLI

Status: Backlog

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
Commands run:
Checks passed:
Known gaps:
```

