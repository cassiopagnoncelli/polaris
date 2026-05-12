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

## Acceptance Criteria

- [ ] Key create command outputs raw key exactly once.
- [ ] Key list never displays raw secret.
- [ ] Revoke disables key for ingestion.
- [ ] Rotate creates a replacement and audits the action.
- [ ] Tests cover hash/verify behavior and no raw secret persistence.

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

