# P7-002: Replay Planner Dry Run

Status: Backlog

## Goal

Build replay planning and dry-run output before any replay execution exists.

## Required Reading

- [Processors and Replay](../../architecture/05-processors-and-replay.md)
- [Redpanda Topics](../../architecture/03-redpanda-topics.md)
- [Implementation Roadmap](../delivery-roadmap.md)

## Dependencies

- P7-001
- P0-007

## Write Scope

Allowed:

```text
packages/shared-replay/
apps/polaris-cli/
```

Forbidden:

```text
processors/*/v*/src/
consumers/*/v*/src/
```

## Implementation Notes

Dry-run output should estimate or report:

```text
source topic
project/environment scope
time or offset range
target processor/consumer/version
expected destination behavior
known risk flags
planned consumer group
```

If exact event counts are not available yet, output that explicitly rather than pretending.

## Acceptance Criteria

- [ ] Planner produces deterministic dry-run output.
- [ ] Planner refuses unscoped production replays.
- [ ] Destination sends are shown as disabled by default.
- [ ] CLI can render dry-run output as human text and JSON.
- [ ] Tests cover replay scope validation.

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

