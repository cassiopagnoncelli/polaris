# P11-008: Topic Isolation and Per-Project Metrics

Status: Ready

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

- [ ] `topic_isolations` migration exists.
- [ ] Topic-family resolver in `shared-kafka` returns the concrete topic for any (family, project_id, environment) combination.
- [ ] Resolver is covered by tests for both shared and isolated cases.
- [ ] All Redpanda metric emissions carry the required labels.
- [ ] CLI `topics isolate` and `topics deisolate` work end to end against the dev compose.
- [ ] `topics isolate` and `topics deisolate` declare `mutates: true`; the dispatcher gate rejects them in production with `declared` source.
- [ ] Grafana dashboards for the four required per-project views exist.
- [ ] Cutover procedure is documented in a runbook.

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
