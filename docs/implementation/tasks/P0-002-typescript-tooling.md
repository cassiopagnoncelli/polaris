# P0-002: TypeScript Tooling Baseline

Status: Backlog

## Goal

Add strict TypeScript, Biome, and Vitest baseline configuration for the monorepo.

## Required Reading

- [Engineering Standards](../../architecture/09-engineering-standards.md)
- [Claude Instructions](../../instructions/claude.md)

## Dependencies

- P0-001.

## Write Scope

Allowed:

```text
package.json
tsconfig.json
tsconfig.base.json
biome.json
vitest.config.*
```

Forbidden:

```text
apps/
packages/
processors/
consumers/
infra/
sql/
```

## Implementation Notes

- TypeScript must be strict.
- Prefer ESM-first settings.
- Use Biome for formatting/linting.
- Use Vitest for tests.
- Do not add ESLint.
- Do not introduce Turborepo or Nx.

## Acceptance Criteria

- [ ] Strict TypeScript config exists.
- [ ] Biome config exists.
- [ ] Vitest config exists.
- [ ] Root scripts expose typecheck, lint/format check, test, and build placeholders as appropriate.
- [ ] No application code is added.

## Checks

Run where possible:

```text
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

## Handoff

```text
Files changed:
Commands run:
Checks passed:
Known gaps:
```
