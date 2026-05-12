# P11-004: Production Secret Provider Adapter

Status: Backlog

## Goal

Add a production-ready secret provider adapter or a documented adapter interface ready for the chosen deployment environment.

## Required Reading

- [Control Plane](../../architecture/02-control-plane.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)
- [Destinations](../../architecture/06-destinations.md)

## Dependencies

- P0-008
- P11-003

## Write Scope

Allowed:

```text
packages/shared-secrets/
docs/deployment/
docs/operations/
```

Forbidden:

```text
plaintext secrets
destination mapping semantics
```

## Implementation Notes

- If the production secret manager is not chosen, implement the adapter boundary and document how to plug one in.
- Env provider remains valid for local/dev.
- Secret values must never be logged or exposed in errors.

## Acceptance Criteria

- [ ] Production provider interface is documented.
- [ ] At least one non-env provider adapter exists or is explicitly stubbed.
- [ ] Tests prove secrets are not exposed in errors.
- [ ] Deployment docs explain `secret_provider` and `secret_ref`.

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

