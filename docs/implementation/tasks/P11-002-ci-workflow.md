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
Commands run:
Checks passed:
Known gaps:
```

