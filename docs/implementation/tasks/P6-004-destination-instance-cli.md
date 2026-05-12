# P6-004: Destination Instance CLI

Status: Ready

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

- [ ] Destination list/show commands exist.
- [ ] Create/update commands only affect runtime instance fields.
- [ ] Enable/disable writes audit records.
- [ ] CLI cannot define event-to-vendor mappings.
- [ ] Tests protect against semantic mapping fields entering the DB model.

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

