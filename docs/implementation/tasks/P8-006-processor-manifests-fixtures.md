# P8-006: Processor Manifests and Golden Fixtures

Status: Backlog

## Goal

Standardize processor manifests, changelogs, and golden fixtures across all v1 processors.

## Required Reading

- [Processors and Replay](../../architecture/05-processors-and-replay.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)
- [ADR 0001](../../adr/0001-architecture-decisions.md)

## Dependencies

- P8-002
- P8-003
- P8-004
- P8-005

## Write Scope

Allowed:

```text
processors/*/v1/
docs/development/
```

Forbidden:

```text
apps/
packages/web-sdk/
packages/node-sdk/
consumers/
```

## Implementation Notes

Every released processor version should have:

```text
processor.manifest.yaml
CHANGELOG.md
fixtures/
tests/
```

Manifests should identify input/output topics, input/output schemas, owner, release status, and replay notes.

## Acceptance Criteria

- [ ] All v1 processors have manifests.
- [ ] All v1 processors have changelogs.
- [ ] All v1 processors have golden fixtures.
- [ ] Validation test catches missing manifest fields.
- [ ] Docs explain semantic immutability rule.

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

