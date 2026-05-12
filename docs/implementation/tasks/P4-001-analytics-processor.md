# P4-001: Analytics Processor Skeleton

Status: Review

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

- [x] Versioned processor directory exists.
- [x] Manifest exists.
- [x] Processor consumes `raw.events`.
- [x] Processor emits `analytics.events`.
- [x] Emitted events include processor metadata.
- [x] Tests cover transform behavior with golden fixture.

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
  processors/analytics-projector/v1/package.json                            (new)
  processors/analytics-projector/v1/tsconfig.json                           (new)
  processors/analytics-projector/v1/vitest.config.ts                        (new)
  processors/analytics-projector/v1/processor.manifest.yaml                 (new, SEMANTIC truth)
  processors/analytics-projector/v1/CHANGELOG.md                            (new)
  processors/analytics-projector/v1/src/transform.ts                        (new)
  processors/analytics-projector/v1/src/runtime.ts                          (new)
  processors/analytics-projector/v1/src/config.ts                           (new)
  processors/analytics-projector/v1/src/app.ts                              (new)
  processors/analytics-projector/v1/src/main.ts                             (new)
  processors/analytics-projector/v1/src/index.ts                            (new)
  processors/analytics-projector/v1/test/transform.test.ts                  (new, golden-fixture)
  processors/analytics-projector/v1/test/runtime.test.ts                    (new)
  processors/analytics-projector/v1/test/app.test.ts                        (new)
  processors/analytics-projector/v1/test/golden/payment-approved.input.json (new)
  processors/analytics-projector/v1/test/golden/payment-approved.output.json(new)
  docs/implementation/tasks/P4-001-analytics-processor.md                   (status + handoff)

Untouched in write scope:
  root package.json   — no script needed; pnpm `-r --if-present` already covers it.
  pnpm-workspace.yaml — already declares `processors/*/v*` (was already in place at P0-001).

Commands run:
  pnpm install                                            (picked up new workspace member)
  pnpm build                                              (all 14 packages built)
  pnpm typecheck                                          (passed)
  pnpm test                                               (838 tests passed; 14 new in this package)
  pnpm lint                                               (passed)
  pnpm format:check                                       (passed after biome auto-format)
  pnpm --filter @polaris/processor-analytics-projector-v1 build  (passed)

Checks passed: typecheck, test, lint, format:check, build.

Design notes:
  - Processor identity is name=analytics-projector, version="v1" (string,
    matching architecture-doc example "v2" and ClickHouse
    LowCardinality(String) column type).
  - Emitted analytics.events envelopes carry processor metadata in two
    shapes side by side:
      1. Nested processor: { name, version, ran_at } per architecture doc
         05-processors-and-replay.md "Processor Metadata".
      2. Top-level processor_name / processor_version per ClickHouse
         Kafka Engine table sql/clickhouse/10_analytics_events_queue.sql.
    The Kafka Engine table sets input_format_skip_unknown_fields = 1, so
    the nested object is ignored at ingest while the flat columns
    populate. Downstream replay/lineage tooling can read either form.
  - Transform is a passthrough: event_id, event, schema_version,
    project_id, environment, occurred_at, ingested_at, source, identity,
    context, consent, privacy, properties are copied verbatim. Real
    enrichment is P8.
  - Skeleton scope: consumes all of raw.events regardless of project.
    Per-project activation is P6-005 territory (PostgreSQL runtime state).
  - Service binary (node dist/main.js) wires shared-service-bootstrap
    (/health, /ready, /metrics, graceful shutdown for SIGTERM/SIGINT) the
    same way apps/ingester-api/src/server.ts does. Producer + consumer
    lifecycle is hooked into the shutdown task list.
  - Partition key on analytics.events is computed with the SAME
    buildRawEventsPartitionKey shared-kafka helper used by the ingester,
    so per-identity ordering is preserved end-to-end.
  - analytics.events topic family was ALREADY registered in
    packages/shared-kafka/src/topics.ts as TOPIC_FAMILY_ANALYTICS_EVENTS
    — no shared-kafka edits were required.

Known gaps (out of scope for this task; tracked elsewhere):
  - Per-project enable/disable wiring → P6-005 Processor Runtime CLI.
  - Processor-run records (processor_runs PostgreSQL table) → P8-001
    Processor Runtime Helpers.
  - Retry / DLQ topic wiring (analytics-projector.retry, .dlq) → P8-001.
  - Replay executor that calls transformToAnalyticsEvent over a bounded
    raw.events range → P7-003.
  - Smoke test driving an event through ingester → processor → ClickHouse
    → P5-001 Vertical Slice Smoke Test.
```
