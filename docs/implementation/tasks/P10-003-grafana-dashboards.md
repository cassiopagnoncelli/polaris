# P10-003: Grafana Dashboards

Status: Backlog

## Goal

Add initial Grafana dashboards for core Polaris operations.

## Required Reading

- [Observability and Operations](../../architecture/08-observability-and-operations.md)
- [Delivery Roadmap](../delivery-roadmap.md)

## Dependencies

- P10-001
- P10-002

## Write Scope

Allowed:

```text
infra/grafana/
docs/operations/
```

Forbidden:

```text
apps/
packages/
processors/
consumers/
```

## Implementation Notes

Initial dashboards should cover:

- ingestion acceptance/rejection
- Redpanda throughput/lag if available
- processor consumed/emitted/retry/DLQ counts
- destination delivery success/failure
- ClickHouse ingestion/query health

## Acceptance Criteria

- [ ] Dashboard JSON/provisioning files exist.
- [ ] Dashboards are provisioned by optional observability compose.
- [ ] Panels map to documented metrics.
- [ ] Docs describe dashboard purpose and known gaps.

## Checks

Run where possible:

```text
docker compose -f docker-compose.yml -f docker-compose.observability.yml config
```

## Handoff

```text
Files changed:
Commands run:
Checks passed:
Known gaps:
```

