# P6-002: Projects and Sources CLI

Status: Ready

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
Commands run:
Checks passed:
Known gaps:
```

