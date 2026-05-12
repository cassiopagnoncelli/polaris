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
Commands run:
Checks passed:
Known gaps:
```

