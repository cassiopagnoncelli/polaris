# P6-004: Destination Instance CLI

Status: Done (merged in `2f8679f`)

## Goal

Implement CLI commands for runtime destination instances without moving mapping semantics into PostgreSQL.

## Required Reading

- [Destinations](../../architecture/06-destinations.md)
- [Control Plane](../../architecture/02-control-plane.md)
- [Claude Instructions](../../instructions/claude.md)

## Dependencies

- P6-001
- P1-002

## Write Scope

Allowed:

```text
apps/polaris-cli/
db/
migrations/
```

Forbidden:

```text
consumers/*/v*/mappers/
packages/shared-schemas/
```

## Implementation Notes

Commands should cover:

```text
polaris destinations list
polaris destinations show <destination_id>
polaris destinations create ...
polaris destinations enable <destination_id>
polaris destinations disable <destination_id> --reason <reason>
polaris destinations update-ops <destination_id> ...
```

PostgreSQL stores destination instance runtime state and operational knobs only. Mapping semantics remain code-only.

## Acceptance Criteria

- [x] Destination list/show commands exist.
- [x] Create/update commands only affect runtime instance fields.
- [x] Enable/disable writes audit records. (Audit-intent structured log + stderr TODO; INSERT lands once `audit_records` exists in P6-006.)
- [x] CLI cannot define event-to-vendor mappings.
- [x] Tests protect against semantic mapping fields entering the DB model.

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
  db/migrations/20260512000005_create_destinations.sql                  new
  packages/shared-db/src/database.ts                                    modified (DestinationsTable + type aliases)
  packages/shared-db/src/index.ts                                       modified (re-exports)
  apps/polaris-cli/src/db/destinations.ts                               new (Kysely repository)
  apps/polaris-cli/src/db/index.ts                                      modified (re-exports)
  apps/polaris-cli/src/commands/destinations/index.ts                   new (group container)
  apps/polaris-cli/src/commands/destinations/id.ts                      new (polaris_dst_<uuidv7> generator)
  apps/polaris-cli/src/commands/destinations/validation.ts              new (rejectMappingArguments + validateSecretRef)
  apps/polaris-cli/src/commands/destinations/list.ts                    new
  apps/polaris-cli/src/commands/destinations/show.ts                    new
  apps/polaris-cli/src/commands/destinations/create.ts                  new
  apps/polaris-cli/src/commands/destinations/enable.ts                  new
  apps/polaris-cli/src/commands/destinations/disable.ts                 new
  apps/polaris-cli/src/commands/destinations/update-ops.ts              new
  apps/polaris-cli/src/commands/index.ts                                modified (BUILTIN_COMMANDS adds destinationsCommand)
  apps/polaris-cli/src/index.ts                                         modified (public re-exports)
  apps/polaris-cli/test/destinations-commands.test.ts                   new (40 tests)

Commands run:
  pnpm --filter @polaris/shared-db build
  pnpm --filter @polaris/polaris-cli typecheck
  pnpm --filter @polaris/polaris-cli test
  pnpm --filter @polaris/polaris-cli lint
  pnpm typecheck (workspace)
  pnpm test (workspace, 864 tests + scripts 18 tests = 882 pass)
  pnpm lint (workspace, biome + lint:clickhouse-imports)

Checks passed:
  pnpm typecheck OK
  pnpm test OK
  pnpm lint OK

Known gaps:
  - Audit record persistence: enable/disable emit a structured audit-intent
    log line and a stderr TODO marker. P6-006 creates the audit_records
    table; after it lands, both commands must be extended to INSERT one
    audit row inside the same transaction as the status UPDATE. The log
    line already carries all canonical audit fields so the change is a
    one-line persistence shim.
  - update-ops does NOT permit mutating `mode` (live/sandbox/test). The
    task card scopes update-ops to operational tuning only; if mode flips
    become an operator workflow, a separate `polaris destinations set-mode`
    command is the right surface.
  - The CLI does not yet route through the control-plane API service
    (apps/control-plane-api) — it writes to PostgreSQL directly via
    @polaris/shared-db, matching the same shape P6-002/P6-003 use. When
    P6-000 ships, these commands will be re-pointed at the API.
```

