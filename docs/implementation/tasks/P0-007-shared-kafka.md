# P0-007: Shared Kafka Package

Status: Done

## Goal

Create a thin `shared-kafka` package around KafkaJS for standard producers, consumers, headers, partition keys, serialization, and DLQ helpers.

## Required Reading

- [Redpanda Topics](../../architecture/03-redpanda-topics.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)
- [Claude Instructions](../../instructions/claude.md)

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
  packages/shared-kafka/                                  new package @polaris/shared-kafka
    package.json
    tsconfig.json (extends ../../tsconfig.base.json)
    vitest.config.ts
    src/{index,client,producer,consumer,topics,topic-family,partition-key,headers,serialization,dlq,hooks}.ts
    test/{client,producer,headers,hooks,partition-key,serialization,topic-family,topics,dlq}.test.ts

Commands run:
  pnpm install
  pnpm typecheck                       PASS
  pnpm lint                            PASS (warnings only)
  pnpm format:check                    PASS
  pnpm test                            PASS
  pnpm --filter @polaris/shared-kafka build  PASS

Checks passed:
  - Thin KafkaJS wrapper. Producer/consumer factories, retry defaults, metrics + logging hooks.
  - Partition-key generator follows 03-redpanda-topics.md: project_id:environment:identity with customer_id > anonymous_id > session_id > event_id fallback.
  - Topic-family resolver returns the concrete topic name from a logical family (shared topics default; per-project dedicated topics via topic_isolations lookup handle).
  - DLQ publishing helper preserves source-event metadata, error class, attempts, and timestamps.
  - Header constants for POLARIS_HEADER_EVENT_ID, POLARIS_HEADER_PROJECT_ID, POLARIS_HEADER_ENVIRONMENT, POLARIS_HEADER_TOPIC_FAMILY.
  - Hooks fan out via composeHooks; emit failures never crash the producer/consumer hot path.

Known gaps:
  - Workspace tooling rebase was needed at agent start (worktree branched from pre-P0-002 main); EXPECTED_BASE_COMMITS preamble caught it.
  - Initial submission referenced an undefined `baseHookPayload` helper; added at integration time (consumer.ts) to keep the per-message hook emit working.
  - Topic-isolations PostgreSQL lookup integration is left to P11-008; this package accepts a resolver callback so the wiring is decoupled.
```

