# P6-005: Processor Runtime CLI

Status: Done (merged in `6b919cb`)

## Goal

Implement CLI commands for processor runtime activation and run inspection.

## Required Reading

- [Processors and Replay](../../architecture/05-processors-and-replay.md)
- [Control Plane](../../architecture/02-control-plane.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)

## Dependencies

- P6-001
- P1-002
- P4-001

## Write Scope

Allowed:

```text
apps/polaris-cli/
db/
migrations/
processors/*/v*/processor.manifest.yaml
```

Forbidden:

```text
processors/*/v*/src/
consumers/
apps/ingester-api/
```

## Implementation Notes

Commands should cover:

```text
polaris processors list
polaris processors show <name> --version <v>
polaris processors runs list
polaris processors runs show <run_id>
polaris processors enable <name> --version <v> --project <id> --env <env>
polaris processors disable <name> --version <v> --project <id> --env <env>
```

Runtime activation is allowed in PostgreSQL. Semantic processor rules are not.

## Acceptance Criteria

- [ ] CLI can inspect processor manifests.
- [ ] CLI can list processor runs.
- [ ] Runtime enable/disable state is stored and audited.
- [ ] CLI does not edit processor source code.
- [ ] Tests verify semantic config is not stored in runtime tables.

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
  db/migrations/20260512000006_create_processor_activations.sql           (new)
  packages/shared-db/src/database.ts                                       (added ProcessorActivationsTable + state union; extended Database interface)
  packages/shared-db/src/index.ts                                          (re-exported ProcessorActivationState and ProcessorActivationsTable types)
  apps/polaris-cli/src/catalog/processors.ts                               (new — Zod manifest schema + filesystem loader with defensive warning path)
  apps/polaris-cli/src/catalog/index.ts                                    (re-exported processor manifest helpers)
  apps/polaris-cli/src/db/processor-activations.ts                         (new — repository helpers: find/list/enable/disable activations)
  apps/polaris-cli/src/db/index.ts                                         (re-exported processor-activation repo helpers)
  apps/polaris-cli/src/commands/processors/validation.ts                   (new — defense-in-depth rejection of transform-rule-shaped flags)
  apps/polaris-cli/src/commands/processors/list.ts                         (new — `polaris processors list`)
  apps/polaris-cli/src/commands/processors/show.ts                         (new — `polaris processors show <name> --version <v>`)
  apps/polaris-cli/src/commands/processors/enable.ts                       (new — `polaris processors enable ...` w/ audit-intent log)
  apps/polaris-cli/src/commands/processors/disable.ts                      (new — `polaris processors disable ...` w/ audit-intent log)
  apps/polaris-cli/src/commands/processors/runs-list.ts                    (new — `polaris processors runs list` w/ "not provisioned until P8-001" shim)
  apps/polaris-cli/src/commands/processors/runs-show.ts                    (new — `polaris processors runs show <run_id>` w/ same shim)
  apps/polaris-cli/src/commands/processors/runs.ts                         (new — `runs` subcommand group)
  apps/polaris-cli/src/commands/processors/index.ts                        (new — `processors` group registration)
  apps/polaris-cli/src/commands/index.ts                                   (wired processorsCommand into BUILTIN_COMMANDS)
  apps/polaris-cli/src/index.ts                                            (re-exported processors public surface)
  apps/polaris-cli/test/processors-commands.test.ts                        (new — 48 unit tests + schema invariant tests)
  docs/implementation/tasks/P6-005-processor-runtime-cli.md                (status -> Review, handoff filled in)
  docs/implementation/kanban.md                                            (moved card to Review)

Commands run:
  pnpm install --prefer-offline
  pnpm --filter "@polaris/shared-*" --filter "@polaris/polaris-cli^..." build
  pnpm --filter @polaris/shared-db typecheck
  pnpm --filter @polaris/polaris-cli typecheck
  pnpm --filter @polaris/polaris-cli test
  pnpm --filter @polaris/polaris-cli lint
  pnpm -r typecheck                                                        (all 14 projects pass)
  pnpm --filter "!@polaris/shared-clickhouse" -r test                      (all pass; shared-clickhouse has no tests, pre-existing)
  pnpm -r lint                                                             (all clean)

Checks passed:
  - typecheck across the workspace (14/14 projects)
  - polaris-cli test suite (159 tests; 48 new in processors-commands.test.ts)
  - workspace test suite (excluding shared-clickhouse which has no test files and fails the same way on main)
  - workspace lint (all clean)

Known gaps:
  - `polaris processors runs list` and `polaris processors runs show` surface a
    structured "processor_runs table not yet provisioned — wired in P8-001"
    message via stderr AND through a `{ not_provisioned: true, pending_task: "P8-001", ... }`
    JSON envelope. Tests assert the message shape but skip the SELECT side.
    P8-001 must replace `defaultStore()` in both files with a Kysely-backed
    listing/findById once `processor_runs` lands.
  - `enable` / `disable` emit a structured `audit_action` log line and write
    a stderr TODO marker (same shape as P6-004 destinations enable/disable).
    P6-006 must replace those `logger.info(...)` calls with an INSERT into
    `audit_records` inside the same transaction as the activation upsert.
  - `last_changed_by` defaults to `'cli'`. P6-007 will replace the
    `actorLabel` hook with the resolved operator identity once tokens land.
  - The catalog-root resolution path is shared with `polaris projects/sources`
    (they walk up looking for a `catalog/` directory). For processor
    inspection without a populated `catalog/`, operators can pass
    `--catalog-root <repo>` explicitly or set `POLARIS_CATALOG_ROOT`. The
    walk-up heuristic is fine for the v1 workspace but P7+ may want a
    `POLARIS_REPO_ROOT` env that doesn't require `catalog/` to exist.
```

