# P6-005: Processor Runtime CLI

Status: Ready

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
Commands run:
Checks passed:
Known gaps:
```

