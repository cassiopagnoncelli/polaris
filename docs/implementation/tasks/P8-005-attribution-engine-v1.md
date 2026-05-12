# P8-005: Attribution Engine v1

Status: Backlog

## Goal

Implement the first conservative attribution processor using captured campaign/click context.

## Required Reading

- [Processors and Replay](../../architecture/05-processors-and-replay.md)
- [SDK Standards](../../architecture/10-sdk-standards.md)
- [Event Contract](../../architecture/01-event-contract.md)

## Dependencies

- P8-001
- P8-003
- P0-006

## Write Scope

Allowed:

```text
processors/attribution-engine/v1/
catalog/events/attribution/
packages/shared-schemas/src/events/attribution/
```

Forbidden:

```text
packages/web-sdk/
packages/node-sdk/
apps/ingester-api/
consumers/
```

## Implementation Notes

- The SDK captures campaign/click context but does not interpret attribution.
- Start with conservative deterministic rules.
- Do not add vendor-specific semantics upstream.
- Attribution rules are semantic processor behavior and must be versioned.

## Acceptance Criteria

- [ ] Versioned processor exists with manifest and changelog.
- [ ] Deterministic attribution fixtures exist.
- [ ] Vendor-specific destination logic is absent.
- [ ] Output events include processor metadata.
- [ ] Replay notes describe how v1 behavior may affect historical outputs.

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

