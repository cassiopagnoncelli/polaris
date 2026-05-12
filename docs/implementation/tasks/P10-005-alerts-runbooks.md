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

Alert thresholds can start conservative and be revised after real traffic.

## Acceptance Criteria

- [ ] Alert rule files exist or documented placeholders exist.
- [ ] Runbooks exist for listed failure modes.
- [ ] Runbooks include commands and dashboard pointers where possible.
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

