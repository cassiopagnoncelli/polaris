# P10-005: Alerts and Incident Runbooks

Status: Backlog

## Goal

Create initial alert rules and incident runbooks for common Polaris failure modes.

## Required Reading

- [Observability and Operations](../../architecture/08-observability-and-operations.md)
- [Delivery Roadmap](../delivery-roadmap.md)

## Dependencies

- P10-002
- P10-003

## Write Scope

Allowed:

```text
infra/prometheus/
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

Runbooks should cover:

- ingestion rejection spike
- Redpanda publish failures
- processor lag
- DLQ growth
- destination API failure
- ClickHouse ingestion lag
- replay stuck/failure

### Initial alert thresholds

These are v1 defaults. They start permissive enough to avoid alert fatigue and are tightened after observed traffic.

```text
ingestion schema rejection rate           page when sustained >5% over 5 minutes
ingestion forbidden-field rejection rate  page when sustained >1% over 5 minutes
Redpanda publish failure rate             page when >0.5% over 1 minute
Redpanda consumer lag (any topic)         warn at 5 min lag, page at 15 min
processor DLQ growth rate                 warn at >100/min, page at >1000/min
destination delivery failure rate         page when >1% over 5 minutes per destination instance
destination DLQ growth rate               page when >50/min per destination instance
ClickHouse Kafka ingestion lag            warn at 2 min, page at 10 min
ClickHouse MV failure                     page on any MV in failed state
replay job stuck                          page when no progress for 30 min on an executing job
operator gate denial rate                 warn when sustained >5/min (suggests credential confusion)
```

All alert labels include `project_id`, `environment`, and the relevant topic/processor/consumer where applicable.

### Initial SLOs

```text
ingester accept latency p99      200 ms
ingester accept latency p999     500 ms
end-to-end (raw -> analytics)    p99 60 s
destination delivery latency     vendor-specific; documented per consumer
```

SLOs are operational targets, not contractual SLAs. Burn-rate alerts come later.

## Acceptance Criteria

- [ ] Alert rule files exist or documented placeholders exist.
- [ ] Runbooks exist for listed failure modes.
- [ ] Runbooks include commands and dashboard pointers where possible.
- [ ] Initial alert thresholds match the table above and are documented as v1 defaults subject to revision.
- [ ] Initial SLOs are documented with the v1 default targets.
- [ ] Docs state thresholds are initial defaults.

## Checks

Run where possible:

```text
rg -n "ingestion|processor|destination|ClickHouse|replay" docs/operations infra/prometheus
```

## Handoff

```text
Files changed:
Commands run:
Checks passed:
Known gaps:
```

