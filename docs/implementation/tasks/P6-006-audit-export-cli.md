# P6-006: Audit and Export CLI

Status: Ready

## Goal

Implement audit inspection and export commands for runtime/control state.

## Required Reading

- [Control Plane](../../architecture/02-control-plane.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)
- [Delivery Roadmap](../delivery-roadmap.md)

## Dependencies

- P6-001
- P6-002
- P6-003

## Write Scope

Allowed:

```text
apps/polaris-cli/
db/
migrations/
docs/development/
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
polaris audit list
polaris audit show <audit_id>
polaris export runtime-state --format yaml|json
polaris export keys-metadata
polaris export destinations
```

Exports must never include plaintext secrets.

## Acceptance Criteria

- [ ] Audit list/show commands exist.
- [ ] Runtime export excludes secret values.
- [ ] Export output is deterministic enough for review.
- [ ] Tests cover secret redaction in exports.

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

