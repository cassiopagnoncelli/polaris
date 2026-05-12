# P6-001: Control-Plane CLI Shell

Status: Backlog

## Goal

Create the `polaris` CLI shell with command structure, shared config, logger, database connection setup, and stable output conventions.

## Required Reading

- [Control Plane](../../architecture/02-control-plane.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)
- [Codex Instructions](../../instructions/codex.md)

## Dependencies

- P0-003
- P0-004
- P1-002

## Write Scope

Allowed:

```text
apps/polaris-cli/
packages/shared-config/
packages/shared-logger/
package.json
pnpm-workspace.yaml
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

- The command name is `polaris`.
- Output should support human-readable tables and JSON where practical.
- Use the same runtime config package as services.
- Do not implement all commands in this task; create the shell and one harmless command like `polaris version`.

## Acceptance Criteria

- [ ] CLI package exists.
- [ ] `polaris version` or equivalent works.
- [ ] CLI loads validated config.
- [ ] CLI can establish a PostgreSQL connection when configured.
- [ ] README or help output documents command conventions.

## Checks

Run where possible:

```text
pnpm typecheck
pnpm test
pnpm lint
pnpm --filter polaris-cli build
```

## Handoff

```text
Files changed:
Commands run:
Checks passed:
Known gaps:
```

