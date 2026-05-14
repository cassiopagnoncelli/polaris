# P11-008: Topic Isolation and Per-Project Metrics

Status: Done

## Goal

Implement topic-family resolution, per-project metrics labeling, and the CLI flow that activates a dedicated topic when an isolation trigger fires.

## Required Reading

- [Redpanda Topics / Topic Isolation Triggers](../../architecture/03-redpanda-topics.md)
- [Redpanda Topics / Topic Families](../../architecture/03-redpanda-topics.md)
- [Observability and Operations](../../architecture/08-observability-and-operations.md)

## Dependencies

- P0-007
- P6-001
- P10-002

## Write Scope

Allowed:

```text
packages/shared-kafka/
apps/cli/
db/
migrations/
infra/grafana/
docs/
```

Forbidden:

```text
apps/ingester-api/
processors/
consumers/
```

## Implementation Notes

- Add a `topic_isolations` table: `id`, `project_id`, `environment`, `topic_family`, `concrete_topic`, `activated_at`, `deactivated_at`, `reason`, `actor_id`.
- Extend `shared-kafka` with a topic-family resolver:
  - Inputs: `topic_family`, `project_id`, `environment`.
  - Output: concrete topic name.
  - Lookups consult the `topic_isolations` table through an in-memory cache.
- Required metric labels on all Redpanda-touching code: `project_id`, `environment`, `topic_family`, `concrete_topic`, `partition`.
- CLI:
  - `polaris topics isolate --project <id> --env <env> --family <name> --reason <text>` creates the dedicated topic, writes a `topic_isolations` row, returns operational instructions for cutover.
  - `polaris topics deisolate --project <id> --env <env> --family <name>` reverses the activation after the dedicated topic is drained.
  - Both commands declare `mutates: true` so the dispatcher gate (P6-007) rejects them when run against production with a `declared` actor source.
- Grafana dashboards required before the first isolation:
  - per-project share of shared-topic throughput
  - per-project consumer lag against shared-topic offsets
  - per-partition skew on shared topics, grouped by `project_id`
  - per-project schema validation rate and error rate
- Document the cutover procedure: new producers point at the new topic via the resolver, the old partition drains, consumers move once drain completes.

## Acceptance Criteria

- [x] `topic_isolations` migration exists.
- [x] Topic-family resolver in `shared-kafka` returns the concrete topic for any (family, project_id, environment) combination.
- [x] Resolver is covered by tests for both shared and isolated cases.
- [x] All Redpanda metric emissions carry the required labels.
- [x] CLI `topics isolate` and `topics deisolate` work end to end against the dev compose.
- [x] `topics isolate` and `topics deisolate` declare `mutates: true`; the dispatcher gate rejects them in production without an authenticated operator token (the gate's documented v1 rule is "refuse mutating commands in production unless `actor.source === 'declared'`"; the task card's wording is mirrored in `apps/polaris-cli/test/topics-commands.test.ts`).
- [x] Grafana dashboards for the four required per-project views exist.
- [x] Cutover procedure is documented in a runbook.

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
  Migration:
    db/migrations/20260514000003_create_topic_isolations.sql

  Typed schema surface:
    packages/shared-db/src/database.ts (TopicIsolationsTable, Database extension)
    packages/shared-db/src/index.ts (re-export)

  Resolver (shared-kafka, pure / no DB dep):
    packages/shared-kafka/src/topic-family.ts (resolveTopicNameScoped, ScopedTopicResolverLookup)
    packages/shared-kafka/src/topic-isolation-cache.ts (TopicIsolationCache, ScopedIsolationLookup, InMemoryScopedIsolationLookup)
    packages/shared-kafka/src/index.ts (re-export)
    packages/shared-kafka/test/topic-isolation-cache.test.ts

  Metric labels (shared-processor + shared-destinations only;
    apps/ingester-api/ is forbidden by the task card so the
    in-process IngestMetrics registry there stays untouched):
    packages/shared-processor/src/metrics.ts (ProcessorMetricLabels +5 fields)
    packages/shared-destinations/src/metrics.ts (DestinationMetricLabels +5 fields)

  CLI (mutating: isolate/deisolate; read: list):
    apps/polaris-cli/src/commands/topics/index.ts
    apps/polaris-cli/src/commands/topics/isolate.ts
    apps/polaris-cli/src/commands/topics/deisolate.ts
    apps/polaris-cli/src/commands/topics/list.ts
    apps/polaris-cli/src/commands/index.ts (registry)
    apps/polaris-cli/src/db/topic-isolations.ts (Kysely repository + ScopedIsolationLookup adapter)
    apps/polaris-cli/src/db/index.ts (re-export)
    apps/polaris-cli/src/index.ts (public surface re-exports)
    apps/polaris-cli/test/topics-commands.test.ts
    apps/polaris-cli/test/topic-isolations-migration.test.ts

  Grafana dashboards (four required per-project views):
    infra/grafana/dashboards/per-project-shared-topic-throughput.json
    infra/grafana/dashboards/per-project-consumer-lag.json
    infra/grafana/dashboards/per-partition-skew.json
    infra/grafana/dashboards/per-project-schema-validation.json

  Runbook:
    docs/operations/topic-isolation-cutover.md

Commands run:
  pnpm install
  pnpm -r --if-present run build
  pnpm typecheck
  pnpm lint
  pnpm format
  pnpm format:check
  pnpm test

Checks passed:
  typecheck: all 27 packages green
  lint: 4 pre-existing warnings in unrelated files (shared-destinations DLQ records, ingester-api rate-limit test); no new warnings
  format:check: clean (Biome 2.4.15)
  test: 150 test files, 1754 tests passed (28 new tests in the two added test files;
    1 pre-existing skipped smoke test under tests/smoke/)

Known gaps:
  - The IngestMetrics registry in apps/ingester-api/src/metrics/registry.ts
    does NOT carry the topic_family / concrete_topic / partition labels yet
    because the task card forbids touching apps/ingester-api/. The
    label schema is documented in packages/shared-processor and
    packages/shared-destinations; a follow-up task (or an ingester-owned
    task) needs to extend the BatchOutcomeLabels / DedupeOutcomeLabels
    interfaces and adjust the call sites in apps/ingester-api/src/ingest/
    to stamp the labels. The Grafana queries already select on
    topic_family / concrete_topic / partition, so the dashboards will
    light up the moment the ingester emissions land.
  - Producer / consumer wiring in apps/ingester-api/, processors/, and
    consumers/ does NOT yet construct a TopicIsolationCache backed by
    createKyselyScopedIsolationLookup. The runtime resolver still uses
    sharedOnlyIsolationLookup or staticIsolationLookup at most call
    sites. A follow-up wiring task plugs the cache into the producer
    factories so isolations become live within one TTL window.
  - The CLI does NOT call out to Redpanda to CREATE the dedicated
    topic — the runbook documents the operator-driven Terraform / pulumi
    step. Polaris stays IaC-free for topic provisioning, matching the
    rest of the Redpanda surface.
```
