# P0-007: Shared Kafka Package

Status: Backlog

## Goal

Create a thin `shared-kafka` package around KafkaJS for standard producers, consumers, headers, partition keys, serialization, and DLQ helpers.

## Required Reading

- [Redpanda Topics](../../architecture/03-redpanda-topics.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)
- [Codex Instructions](../../instructions/codex.md)

## Dependencies

- P0-003
- P0-004
- P0-006

## Write Scope

Allowed:

```text
packages/shared-kafka/
package.json
pnpm-workspace.yaml
```

Forbidden:

```text
apps/
processors/
consumers/
```

## Implementation Notes

- Use KafkaJS.
- Keep the wrapper thin and transparent.
- Implement the default raw event partition key helper:
  `project_id + ":" + environment + ":" + best_available_identity`.
- Include topic constants.
- Do not build a stream-processing framework.

## Acceptance Criteria

- [ ] Package exports producer/consumer factory helpers.
- [ ] Package exports topic constants.
- [ ] Package exports partition key helper with tests.
- [ ] Package exposes DLQ helper types or stubs.

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

