# P10-001: Observability Compose

Status: Ready

## Goal

Add optional Docker Compose services for Prometheus, Grafana, Loki, and OpenTelemetry Collector.

## Required Reading

- [Observability and Operations](../../architecture/08-observability-and-operations.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)

## Dependencies

- P1-001

## Write Scope

Allowed:

```text
docker-compose.observability.yml
infra/prometheus/
infra/grafana/
infra/loki/
infra/otel/
docs/development/
```

Forbidden:

```text
apps/
packages/
processors/
consumers/
docker-compose.yml except documented service labels if needed
```

## Implementation Notes

- Main compose stays lean.
- Observability compose is optional.
- Core services must not require observability backends to start.

## Acceptance Criteria

- [ ] Optional observability compose exists.
- [ ] Prometheus can scrape service metrics endpoints when services are running.
- [ ] Grafana is configured with local data sources where practical.
- [ ] Loki/OTel config is present or clearly stubbed.
- [ ] Docs show how to start optional stack.

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

