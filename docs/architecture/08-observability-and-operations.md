# Observability and Operations

## Observability Target

Polaris has a full observability target with graceful degradation.

Preferred stack:

```text
Prometheus
Grafana
Loki
OpenTelemetry Collector
```

These backends are preferred but not hard runtime dependencies. Core services must continue running if Grafana, Loki, Prometheus, or the OTel collector are unavailable.

## Service Contract

Every service exposes:

- structured JSON logs
- Prometheus-compatible metrics endpoint
- health endpoint
- readiness endpoint
- build/version info
- OpenTelemetry trace hooks where useful

Shared packages should standardize logging, metrics labels, and trace setup.

## Standard Log Fields

Logs should include stable identifiers where applicable:

```text
event_id
project_id
environment
source_id
topic
partition
offset
processor_name
processor_version
consumer_name
consumer_version
replay_job_id
destination_id
```

## Metrics to Track

Ingestion:

- request rate
- accepted events
- rejected events
- schema rejection rate
- forbidden-field rejection/redaction count
- publish latency
- RabbitMQ publish failures

RabbitMQ:

- topic throughput
- consumer lag
- broker health
- retention usage
- partition imbalance

Processors:

- events consumed
- events emitted
- processing latency
- retry count
- DLQ count
- replay progress
- state-store latency

Destination consumers:

- delivery success rate
- API error rate
- rate-limit events
- retry volume
- DLQ volume
- batch size
- destination latency

ClickHouse:

- ClickHouse ingestion lag
- materialized view failures
- insert throughput
- query latency
- disk usage
- parts count
- projection table freshness

Control plane:

- replay job status
- replay duration
- key revocation/rotation audit count
- destination disabled/degraded count

## Local Development Stack

Polaris uses a lean profile-based local development stack.

The main `docker-compose.yml` should run the core data path:

```text
RabbitMQ
PostgreSQL
Redis
ClickHouse
```

Optional compose files add heavier services:

```text
docker-compose.observability.yml
docker-compose.destinations.yml
```

Example commands:

```text
docker compose up
docker compose -f docker-compose.yml -f docker-compose.observability.yml up
docker compose -f docker-compose.yml -f docker-compose.destinations.yml up
```

Optional profiles may include:

- Prometheus
- Grafana
- Loki
- OTel Collector
- mock vendor APIs
- webhook sink

Observability should be easy to run locally, but not required for core development.

