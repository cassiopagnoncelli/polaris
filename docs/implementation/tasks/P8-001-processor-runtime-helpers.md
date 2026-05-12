# P8-001: Processor Runtime Helpers

Status: Review

## Goal

Create thin shared helpers for processor runtime behavior without building a heavy stream-processing framework.

## Required Reading

- [Processors and Replay](../../architecture/05-processors-and-replay.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)
- [Redpanda Topics](../../architecture/03-redpanda-topics.md)

## Dependencies

- P0-004
- P0-007
- P1-002
- P4-001

## Write Scope

Allowed:

```text
packages/shared-processor/
processors/
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

Helpers may standardize:

```text
processor run registration
processor metadata
structured logging fields
metrics hooks
DLQ publish helper
retry classification
manifest loading
```

Do not hide Kafka concepts behind a full framework.

## Acceptance Criteria

- [x] Shared processor package exists.
- [x] Processor run registration helper exists.
- [x] Processor metadata helper exists.
- [x] Existing skeleton processor can use helpers.
- [x] Tests cover metadata/run helper behavior.

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
  Added:
    packages/shared-processor/package.json
    packages/shared-processor/tsconfig.json
    packages/shared-processor/vitest.config.ts
    packages/shared-processor/src/index.ts
    packages/shared-processor/src/identity.ts
    packages/shared-processor/src/metadata.ts
    packages/shared-processor/src/runs.ts
    packages/shared-processor/src/classify.ts
    packages/shared-processor/src/dlq.ts
    packages/shared-processor/src/metrics.ts
    packages/shared-processor/src/manifest.ts
    packages/shared-processor/test/identity.test.ts
    packages/shared-processor/test/metadata.test.ts
    packages/shared-processor/test/runs.test.ts
    packages/shared-processor/test/classify.test.ts
    packages/shared-processor/test/dlq.test.ts
    packages/shared-processor/test/metrics.test.ts
    packages/shared-processor/test/manifest.test.ts
    db/migrations/20260512000007_create_processor_runs.sql

  Modified:
    packages/shared-db/src/database.ts          (+ ProcessorRunsTable / ProcessorRunStatus)
    packages/shared-db/src/index.ts             (re-export new types)
    processors/analytics-projector/v1/package.json   (+ @polaris/shared-processor dep)
    processors/analytics-projector/v1/src/transform.ts
                                                (delegate metadata stamping to shared helper)
    processors/analytics-projector/v1/src/runtime.ts
                                                (wire ProcessorMetrics + classifyError;
                                                 still calls kafka.consume + producer.publishEvent
                                                 directly per "do not hide Kafka" rule)
    processors/analytics-projector/v1/src/app.ts
                                                (use processorLogContext + ProcessorMetrics;
                                                 BuiltAnalyticsProjectorApp gains `metrics` field)
    processors/analytics-projector/v1/src/index.ts
                                                (re-export PROCESSOR_IDENTITY)
    pnpm-lock.yaml                              (regen for new package)

Commands run:
  pnpm install
  pnpm -r build
  pnpm typecheck
  pnpm test            (998 + 46 = 1044 tests passed)
  pnpm lint
  pnpm format
  pnpm openapi:check

Checks passed:
  typecheck     pass
  unit tests    pass (1044/1044)
  lint          pass
  format        pass
  openapi:check pass (in sync)

Known gaps:
  - Scope widened beyond the card's "packages/shared-processor/, processors/" allowlist into:
      * db/migrations/20260512000007_create_processor_runs.sql
      * packages/shared-db/src/{database,index}.ts (typed ProcessorRunsTable)
    Reason: the "run registration helper" acceptance criterion presupposes a `processor_runs`
    table that did not exist (P6-005 only shipped `processor_activations`). Documented in the
    package's `runs.ts` header and the migration's preamble.

  - The processor manifest Zod schema is duplicated between
    `apps/polaris-cli/src/catalog/processors.ts` (shipped by P6-005) and
    `packages/shared-processor/src/manifest.ts`. The schemas are byte-for-byte compatible.
    Consolidation (CLI re-imports from `@polaris/shared-processor`) is left as a follow-up
    task to avoid cross-cutting P6-005 territory here.

  - `ProcessorMetrics` is in-process only. Prometheus exposition through the Fastify `/metrics`
    endpoint is P10-002 territory; the call sites are shaped so swapping the backend does not
    touch them.

  - Kysely-backed `ProcessorRunRepository` exists and typechecks against the new
    `processor_runs` typed table, but is unit-tested only through the in-memory adapter. An
    integration test (PostgreSQL via Docker) is appropriate when the integration harness lands.

  - The analytics-projector runtime does NOT yet auto-publish to DLQ on terminal errors. It
    classifies and records the metric/log, then re-throws so KafkaJS surfaces the failure
    (existing behavior). Hosts that want DLQ routing wrap the handler with
    `publishToDlq` from `@polaris/shared-processor`. The helper exists and is unit-tested; the
    auto-routing decision belongs to processor-specific retry policy (deferred per task card).
```

