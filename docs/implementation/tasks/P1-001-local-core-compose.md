# P1-001: Local Core Compose

Status: Done

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
- docker-compose.yml                                  (created)
- infra/clickhouse/config.d/macros.xml                (created)
- infra/clickhouse/config.d/cluster.xml               (created)
- infra/clickhouse/users.d/.gitkeep                   (created)
- infra/docker/.gitkeep                               (created)
- infra/postgres/.gitkeep                             (created)
- infra/redpanda/.gitkeep                             (created)

Commands run:
- docker compose config            (parses cleanly, all 4 services rendered)
- docker compose config --services (lists redpanda, postgres, redis, clickhouse)
- docker compose up -d             (could not run: no docker daemon in sandbox)
- docker compose ps                (could not run: no docker daemon in sandbox)

Checks passed:
- docker-compose.yml exists.
- Core services defined: redpanda, postgres, redis, clickhouse.
- Single Redpanda broker, RF=1, dev-container mode, healthcheck via `rpk cluster health`.
- Single-node ClickHouse without Keeper; {replicated}/{cluster}/{shard}/{replica}
  macros expand to local-safe values via infra/clickhouse/config.d/macros.xml +
  cluster.xml so DDL written for production engines also works locally.
- PostgreSQL 16, Redis 7 with persistence disabled (dedupe/rate-limit only).
- All service ports overridable via *_HOST_PORT env vars and documented inline.
- Named volumes for redpanda/postgres/clickhouse state; no host bind mounts for data.
- Compose does NOT include Grafana/Loki/Prometheus/OTel/destination mocks
  (those are reserved for docker-compose.observability.yml / .destinations.yml).

Known gaps:
- `docker compose up -d` and `docker compose ps` could not be exercised here
  because the Docker daemon is not available in this environment. The compose
  file parses, but live-boot verification needs to happen on a machine with
  Docker running.
- ClickHouse SQL DDL and initdb wiring are intentionally out of scope; they
  land with P1-003 and will mount under /docker-entrypoint-initdb.d/. The
  macros and single-node cluster are already in place to support that DDL
  shape (Replicated* + ON CLUSTER) without templating.
- PostgreSQL migrations (P1-002) will run against this stack; no migration
  scaffolding is added by this task.
- infra/docker/ and infra/redpanda/ are placeholder directories (.gitkeep)
  reserved for future Dockerfiles and any future Redpanda config bootstrap.
```

