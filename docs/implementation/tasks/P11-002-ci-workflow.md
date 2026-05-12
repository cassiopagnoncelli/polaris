# P11-002: CI Workflow

Status: Ready

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
import-restriction check (blocks @clickhouse/client outside shared-clickhouse)
build all packages/services
```

Docker-backed integration/e2e checks may be scheduled or manually triggered until stable.

### ClickHouse access enforcement

ClickHouse query patterns are enforced at the database level through `polaris_service` and `polaris_operator` roles (see P1-003) and at the workspace level through the shared client package (P0-010). The CI surface is small:

- An import-restriction rule (Biome or equivalent) blocks direct `@clickhouse/client` imports anywhere except `packages/shared-clickhouse/`. Violations fail the build.
- The role grants applied by P1-003 prevent `polaris_service`-authenticated code from reading `analytics_raw` at all.

No regex SQL lint is required. Regex-based SQL linting was considered and rejected — it false-positives on CTEs and dynamic SQL, false-negatives on aliased table references, and the escape-hatch comments decay. See [07-clickhouse.md / Access Control](../../architecture/07-clickhouse.md) for the full rationale.

## Acceptance Criteria

- [ ] CI workflow exists.
- [ ] Required PR checks are wired.
- [ ] Integration workflow is separate or optional if heavy.
- [ ] Cache usage is reasonable for pnpm.
- [ ] CI docs explain local equivalents.
- [ ] Import-restriction check blocks `@clickhouse/client` outside `shared-clickhouse` and is verified by a failing-case test.

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
  .github/workflows/ci.yml                              new — PR/push gates
  .github/workflows/integration.yml                     new — Docker integration tier
  scripts/lint-clickhouse-imports.mjs                   new — @clickhouse/client import-restriction lint
  scripts/tsconfig.json                                 new — typechecks scripts/__tests__
  scripts/vitest.config.ts                              new — scripts test runner config
  scripts/__tests__/lint-clickhouse-imports.test.ts     new — 18 tests covering the import-restriction script
  docs/development/ci.md                                new — CI explainer (local equivalents, integration opt-in)
  package.json                                          edited — wires lint:clickhouse-imports into `pnpm lint`,
                                                                 adds `pnpm test:scripts` to `pnpm test`,
                                                                 adds scripts tsconfig to `pnpm typecheck`

Commands run:
  pnpm install
  pnpm build
  pnpm typecheck            -> exit 0
  pnpm lint                 -> exit 0 (Biome + import-restriction)
  pnpm format:check         -> exit 0
  pnpm test                 -> exit 0 (537 workspace + 18 scripts tests)
  node scripts/lint-clickhouse-imports.mjs               -> exit 0 against the live workspace
  POLARIS_CLICKHOUSE_LINT_ROOT=<violation tree> ...      -> exit 1 with file:line report

Checks passed:
  - typecheck, lint, format:check, test, build all green locally on Node 22 / pnpm 10.30.0
  - import-restriction script verifies on live workspace and fails the build on a seeded violation
  - YAML parsed cleanly (ci.yml jobs: static-analysis, test, migrations; integration.yml jobs: integration)

Known gaps:
  - Integration workflow currently runs a placeholder step; the real suite lands with P4-002 and P5-001.
  - `pnpm db:migrate` smoke check is the lightest validation dbmate offers (no dry-run mode); see CI doc.
  - Vertical-slice smoke test (P5-001) is the candidate to graduate from `integration.yml` to a required gate.
```

## Rebase note

Rebase: applied, brought in `412c7b2 Sync kanban and task-card statuses with merged state` from main.

