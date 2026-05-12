# P0-001: Workspace Skeleton

Status: Done

## Goal

Create the initial monorepo directory skeleton and workspace metadata without implementing services.

## Required Reading

- [Claude Instructions](../../instructions/claude.md)
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
- package.json (new): root workspace metadata, ESM type, Node>=22 / pnpm>=10 engines, packageManager pinned to pnpm@10.30.0, placeholder orchestration scripts (build/typecheck/lint/format/test/clean using `pnpm -r --if-present`).
- pnpm-workspace.yaml (new): declares workspace globs apps/*, packages/*, processors/*/*, consumers/*/* (the latter two match the versioned `<name>/v<N>` layout in instructions/claude.md).
- apps/.gitkeep (new)
- packages/.gitkeep (new)
- processors/.gitkeep (new)
- consumers/.gitkeep (new)
- catalog/.gitkeep (new)
- infra/.gitkeep (new)
- sql/.gitkeep (new)

Commands run:
- pnpm --version  -> 10.30.0 (PASS)
- node --version  -> v22.14.0 (informational; confirms Active LTS Node available)

Checks passed:
- pnpm --version (the only check listed in the task card).

Known gaps:
- No package/service implementations exist yet (intentional; out of scope for P0-001, forbidden by write scope).
- TypeScript tooling baseline (tsconfig, Biome) is deferred to P0-002.
- The `apps/`, `packages/`, `processors/`, `consumers/`, `catalog/`, `infra/`, `sql/` directories contain only `.gitkeep` placeholders; no `db/` directory was created since the task scope omits it (it will be added when migrations are scaffolded in P1-002).
- `pnpm install` was not run because there are no workspace packages yet and the task only requested `pnpm --version`.
```

