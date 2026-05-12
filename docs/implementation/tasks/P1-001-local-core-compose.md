# P1-001: Local Core Compose

Status: Ready

## Goal

Create a lean local Docker Compose stack for core data-path services.

## Required Reading

- [Observability and Operations](../../architecture/08-observability-and-operations.md)
- [Redpanda Topics](../../architecture/03-redpanda-topics.md)
- [ClickHouse](../../architecture/07-clickhouse.md)

## Dependencies

- None.

## Write Scope

Allowed:

```text
docker-compose.yml
infra/docker/
infra/redpanda/
infra/clickhouse/
infra/postgres/
```

Forbidden:

```text
apps/
packages/
processors/
consumers/
docker-compose.observability.yml
docker-compose.destinations.yml
```

## Implementation Notes

Main compose should include only:

```text
Redpanda
PostgreSQL
Redis
ClickHouse
```

Keep it lean. Optional observability/destination compose files are separate future tasks.

## Acceptance Criteria

- [ ] `docker-compose.yml` exists.
- [ ] Core services are defined.
- [ ] Service ports and volumes are documented or obvious.
- [ ] Compose does not include Grafana/Loki/Prometheus/OTel.

## Checks

Run where possible:

```text
docker compose config
docker compose up -d
docker compose ps
```

## Handoff

```text
Files changed:
Commands run:
Checks passed:
Known gaps:
```

