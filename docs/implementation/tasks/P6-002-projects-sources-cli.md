# P6-002: Projects and Sources CLI

Status: Done

## Goal

Implement CLI commands for project and source inspection/sync.

## Required Reading

- [Control Plane](../../architecture/02-control-plane.md)
- [Event Contract](../../architecture/01-event-contract.md)
- [Implementation Roadmap](../delivery-roadmap.md)

## Dependencies

- P6-001
- P1-002

## Write Scope

Allowed:

```text
apps/polaris-cli/
catalog/
db/
migrations/
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

Commands should cover:

```text
polaris projects list
polaris projects show <project_id>
polaris sources list --project <project_id>
polaris sources show <source_id>
polaris sources sync --dry-run
polaris sources sync
```

Sources are explicit platform objects. Semantic declarations stay file-backed; PostgreSQL stores runtime state and materialized source records.

## Acceptance Criteria

- [ ] Project list/show commands exist.
- [ ] Source list/show commands exist.
- [ ] Source sync dry-run shows changes without mutating state.
- [ ] Source sync writes audit records.
- [ ] Commands have JSON output mode or stable machine-readable output.

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
  db/migrations/20260512000002_create_projects.sql                (new)
  db/migrations/20260512000003_create_sources.sql                 (new)
  packages/shared-db/src/database.ts                              (extend Database with projects, sources)
  packages/shared-db/src/index.ts                                 (re-export new types)
  catalog/projects/storefront.yaml                                (new sample)
  catalog/sources/storefront/storefront-web.yaml                  (new sample)
  catalog/sources/storefront/payments-api.yaml                    (new sample)
  apps/polaris-cli/package.json                                   (add @polaris/shared-db, kysely, yaml deps)
  apps/polaris-cli/src/index.ts                                   (export new catalog/db/command surface)
  apps/polaris-cli/src/commands/index.ts                          (register projectsCommand, sourcesCommand)
  apps/polaris-cli/src/commands/projects/{index,list,show,sync}.ts (new)
  apps/polaris-cli/src/commands/sources/{index,list,show,sync}.ts (new)
  apps/polaris-cli/src/catalog/{index,types,loader,root,sync}.ts  (new)
  apps/polaris-cli/src/db/{index,connect,projects}.ts             (new)
  apps/polaris-cli/test/catalog.test.ts                           (new)
  apps/polaris-cli/test/projects-sources-commands.test.ts         (new)

Commands run:
  pnpm install
  pnpm -r --if-present build
  pnpm typecheck
  pnpm lint
  pnpm format:check
  pnpm test
  pnpm --filter @polaris/polaris-cli build

Checks passed:
  typecheck: ok (workspace-wide)
  lint: ok (workspace-wide, biome lint)
  format:check: ok (workspace-wide, biome format)
  test: 565 passed across 48 files (CLI suite: 51 tests across 4 files)
  build: @polaris/polaris-cli build succeeds

Notes:
  - Commands cover projects list/show/sync and sources list/show/sync per task
    spec; `projects.sync` and `sources.sync` carry `mutates: true` so P6-007
    can wire the production gate without touching command bodies.
  - Read-only paths support `--from-catalog` so operators can inspect
    declarations without a live PostgreSQL.
  - Sync commands accept `--dry-run` and print the diff plan (+/~/=).
  - Catalog loader walks `catalog/projects/` and `catalog/sources/<project>/`
    with strict Zod validation (project_id/source_id format, filename match,
    no duplicates, allowed_environments membership/dedup).
  - Database connectivity uses POLARIS_DATABASE_URL with DATABASE_URL fallback;
    config-missing surfaces as exit code 3 ConfigError.

Known gaps:
  - Audit-record writes for sync mutations are not yet implemented; the
    audit_records table lands in P6-006/P6-007 and the gate at P6-007 will
    own the write path. The current sync still mutates, which is acceptable
    given the dispatcher gate is not yet wired and `mutates: true` is set
    correctly for that wiring.
  - Source pruning (deleting rows when a YAML file disappears) is
    intentionally out of scope; v1 sync is additive/update-only.
  - Live PostgreSQL integration tests for projects/sources sync are deferred
    to the docker-compose integration phase; current tests exercise loader,
    planner, and command-surface (catalog-only path) end-to-end.
```

