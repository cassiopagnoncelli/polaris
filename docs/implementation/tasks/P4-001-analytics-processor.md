# P4-001: Analytics Processor Skeleton

Status: Ready

## Goal

Implement the first simple versioned processor that consumes `raw.events` and emits `analytics.events`.

## Required Reading

- [Processors and Replay](../../architecture/05-processors-and-replay.md)
- [Redpanda Topics](../../architecture/03-redpanda-topics.md)
- [Event Contract](../../architecture/01-event-contract.md)

## Dependencies

- P0-006
- P0-007
- P2-003

## Write Scope

Allowed:

```text
processors/analytics-projector/v1/
package.json
pnpm-workspace.yaml
```

Forbidden:

```text
apps/ingester-api/
packages/web-sdk/
packages/node-sdk/
consumers/
```

## Implementation Notes

- Keep processor version semantics immutable.
- Include processor manifest and changelog.
- Include processor metadata on emitted events.
- This can be a minimal projector/enricher; do not implement full attribution.

## Acceptance Criteria

- [ ] Versioned processor directory exists.
- [ ] Manifest exists.
- [ ] Processor consumes `raw.events`.
- [ ] Processor emits `analytics.events`.
- [ ] Emitted events include processor metadata.
- [ ] Tests cover transform behavior with golden fixture.

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

