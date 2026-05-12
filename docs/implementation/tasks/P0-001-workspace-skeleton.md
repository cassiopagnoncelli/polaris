# P0-001: Workspace Skeleton

Status: Ready

## Goal

Create the initial monorepo directory skeleton and workspace metadata without implementing services.

## Required Reading

- [Codex Instructions](../../instructions/codex.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)
- [Architecture Overview](../../architecture/00-overview.md)

## Dependencies

- None.

## Write Scope

Allowed:

```text
package.json
pnpm-workspace.yaml
apps/.gitkeep
packages/.gitkeep
processors/.gitkeep
consumers/.gitkeep
catalog/.gitkeep
infra/.gitkeep
sql/.gitkeep
```

Forbidden:

```text
apps/*/*
packages/*/*
processors/*/*
consumers/*/*
docker-compose*.yml
```

## Implementation Notes

- Use pnpm workspaces.
- Set `"type": "module"` at the root if appropriate.
- Add only high-level scripts that do not require packages to exist yet.
- Do not add service code.

## Acceptance Criteria

- [ ] Workspace metadata exists.
- [ ] Top-level implementation directories exist.
- [ ] No service/package implementation is created.
- [ ] Scripts are placeholders or root orchestration only.

## Checks

Run where possible:

```text
pnpm --version
```

## Handoff

```text
Files changed:
Commands run:
Checks passed:
Known gaps:
```

