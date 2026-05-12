# P8-002: Identity Resolver v1

Status: Backlog

## Goal

Implement the first authoritative-link identity resolver processor.

## Required Reading

- [Processors and Replay](../../architecture/05-processors-and-replay.md)
- [SDK Standards](../../architecture/10-sdk-standards.md)
- [Event Contract](../../architecture/01-event-contract.md)

## Dependencies

- P8-001
- P0-006

## Write Scope

Allowed:

```text
processors/identity-resolver/v1/
packages/shared-processor/
catalog/events/identity/
packages/shared-schemas/src/events/identity/
```

Forbidden:

```text
apps/ingester-api/
packages/web-sdk/
packages/node-sdk/
consumers/
```

## Implementation Notes

- Canonical graph accepts explicit authoritative links only.
- Heuristics must not mutate canonical identity.
- Storage layer quality from the SDK may be retained as evidence metadata.
- Emit events such as `identity.linked` or equivalent governed event names if defined.
- If schema names are not defined yet, add them through the file-backed catalog and code-backed schemas.

## Acceptance Criteria

- [ ] Versioned processor exists with manifest and changelog.
- [ ] Authoritative overlap links are detected.
- [ ] Heuristic inputs do not create canonical merges.
- [ ] Output events include processor metadata.
- [ ] Golden fixtures cover anonymous-to-customer linking and conflict cases.

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

