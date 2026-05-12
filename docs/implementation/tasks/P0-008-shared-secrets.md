# P0-008: Shared Secrets Package

Status: Backlog

## Goal

Create the provider-based secret reference abstraction.

## Required Reading

- [Control Plane](../../architecture/02-control-plane.md)
- [Destinations](../../architecture/06-destinations.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)

## Dependencies

- P0-003
- P0-004

## Write Scope

Allowed:

```text
packages/shared-secrets/
package.json
pnpm-workspace.yaml
```

Forbidden:

```text
apps/
processors/
consumers/
```

## Implementation Notes

- Implement an `env` provider first.
- Define interfaces for future external secret providers.
- Never log secret values.
- Tests should prove missing secrets fail clearly and values are not exposed by diagnostics.

## Acceptance Criteria

- [ ] Package exports secret provider interface.
- [ ] Package exports env provider.
- [ ] Tests cover successful lookup and missing secret.
- [ ] Secret values are not included in error strings.

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

