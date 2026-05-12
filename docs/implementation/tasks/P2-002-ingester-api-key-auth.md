# P2-002: Ingester API Key Auth

Status: Backlog

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

- [ ] Auth middleware exists.
- [ ] Invalid/revoked/missing key returns Problem Details.
- [ ] Valid key resolves project/environment/source context.
- [ ] Tests cover valid and invalid key behavior.

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

