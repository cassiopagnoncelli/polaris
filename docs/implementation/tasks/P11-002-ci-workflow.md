# P11-002: CI Workflow

Status: Backlog

## Goal

Implement CI checks matching Polaris engineering standards.

## Required Reading

- [Engineering Standards](../../architecture/09-engineering-standards.md)
- [Implementation Roadmap](../delivery-roadmap.md)

## Dependencies

- P0-002
- P0-006
- P1-002

## Write Scope

Allowed:

```text
.github/workflows/
.gitlab-ci.yml
package.json
scripts/
docs/development/
```

Forbidden:

```text
application behavior changes
```

## Implementation Notes

Use the CI system present in the repository. If none exists, prefer GitHub Actions unless the user specifies otherwise.

Required PR checks:

```text
typecheck
Biome lint/format check
unit tests
contract/schema tests
event catalog validation
SQL migration validation
build all packages/services
```

Docker-backed integration/e2e checks may be scheduled or manually triggered until stable.

## Acceptance Criteria

- [ ] CI workflow exists.
- [ ] Required PR checks are wired.
- [ ] Integration workflow is separate or optional if heavy.
- [ ] Cache usage is reasonable for pnpm.
- [ ] CI docs explain local equivalents.

## Checks

Run where possible:

```text
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

## Handoff

```text
Files changed:
Commands run:
Checks passed:
Known gaps:
```

