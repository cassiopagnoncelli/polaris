# Observability

Polaris ships an OPTIONAL local observability stack as a separate
compose overlay. The four core data-path services (RabbitMQ,
PostgreSQL, Redis, ClickHouse) run without it — observability backends
are preferred but not hard runtime dependencies, per
[Observability and Operations](../architecture/08-observability-and-operations.md).

This page is the operator entry point: how to start the stack, what
each piece is for, how to point your Polaris services at it, and which
downstream P10-* task owns which surface.

## What you get

| Component        | URL                       | Purpose                                                                 |
| ---------------- | ------------------------- | ----------------------------------------------------------------------- |
| Prometheus       | <http://localhost:9090>   | Scrapes `polaris_*` metrics from the ingester, processors, and RabbitMQ. |
| Grafana          | <http://localhost:3000>   | Dashboards + datasource fanout. Default login: `admin` / `admin`.        |
| Loki             | <http://localhost:3100>   | Log store. Tail Pino logs from local services and the smoke runs.        |
| OTel Collector   | gRPC `localhost:4317`, HTTP `localhost:4318` | OTLP intake. Forwards metrics to Prometheus, logs to Loki.      |

The compose file is at the repo root: [`docker-compose.observability.yml`](../../docker-compose.observability.yml).
Configuration lives under [`infra/`](../../infra/):

```text
infra/
  prometheus/
    prometheus.yml                  scrape config + global labels
  grafana/
    provisioning/
      datasources/datasources.yml   Prometheus + Loki datasources
      dashboards/dashboards.yml     file-backed dashboard provider
    dashboards/
      polaris-overview.json         placeholder; P10-003 replaces this
  loki/
    loki.yaml                       single-binary local config (7d retention)
  otel/
    collector.yaml                  OTLP receivers + exporters
```

## Starting the stack

The observability compose is an overlay on top of `docker-compose.yml`.
The core stack must already be running (or be started in the same
command) because the overlay reuses the core's `polaris` network for
service discovery.

```bash
# Start core + observability together.
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d

# Or, with the core already up, start only the observability overlay.
docker compose -f docker-compose.observability.yml up -d

# Verify the merged compose without starting anything.
docker compose -f docker-compose.yml -f docker-compose.observability.yml config
```

To stop just the observability overlay (keeping the core data path
running):

```bash
docker compose -f docker-compose.observability.yml down
```

`docker compose down -v` from the same override wipes the
`prometheus-data`, `grafana-data`, and `loki-data` volumes. Use that
when you want a clean slate (forgot the Grafana admin password,
stuck dashboards, corrupted Loki index).

### Override host ports

Host ports use upstream defaults so local tools just work. If a port
clashes, override via env vars before bringing the stack up:

| Env var                    | Default | Service              |
| -------------------------- | ------- | -------------------- |
| `PROMETHEUS_HOST_PORT`     | `9090`  | Prometheus           |
| `GRAFANA_HOST_PORT`        | `3000`  | Grafana              |
| `LOKI_HOST_PORT`           | `3100`  | Loki                 |
| `OTEL_GRPC_HOST_PORT`      | `4317`  | OTel Collector gRPC  |
| `OTEL_HTTP_HOST_PORT`      | `4318`  | OTel Collector HTTP  |
| `OTEL_METRICS_HOST_PORT`   | `8889`  | OTel self-metrics    |

The same `*_HOST_PORT` convention as `docker-compose.yml`.

## Pointing Polaris services at the OTel collector

The ingester and processors emit Pino logs to stdout and expose
`/metrics` for Prometheus scrapes. OpenTelemetry traces and OTLP-only
signals are pushed to the collector via the standard OTel env vars:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
export OTEL_EXPORTER_OTLP_PROTOCOL=grpc
export OTEL_SERVICE_NAME=polaris-ingester
export OTEL_RESOURCE_ATTRIBUTES=service.namespace=polaris,deployment.environment=development
```

For HTTP intake (firewall environments where gRPC is blocked), point
at the HTTP endpoint instead:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

The actual OTel SDK wiring in Polaris services lands with
[P10-002 Metrics Standardization](../../agents/pm/kanban/done/P10-002-metrics-standardization.md).
Today the variables above are forward-compatible: setting them does
not break anything, and the collector ignores empty intake.

## Where the metrics come from

Prometheus scrapes are driven by [`infra/prometheus/prometheus.yml`](../../infra/prometheus/prometheus.yml).
The local scrape config points at:

| Job                              | Target                              | Source                                                                 |
| -------------------------------- | ----------------------------------- | ---------------------------------------------------------------------- |
| `prometheus`                     | `localhost:9090`                    | Prometheus itself (self-scrape).                                       |
| `polaris-ingester`               | `host.docker.internal:8080/metrics` | Ingester API — `apps/ingester-api/src/metrics/registry.ts`.            |
| `polaris-sync-identity`          | `host.docker.internal:8081/metrics` | Identity stage    tor — `packages/shared-processor/src/metrics.ts`.       |
| `polaris-rabbitmq`               | `polaris-rabbitmq:9644/public_metrics` | RabbitMQ admin API (Prometheus-shape).                              |
| `polaris-otel-collector`         | `otel-collector:8889/metrics`       | Collector self-metrics.                                                |

`host.docker.internal` resolves to the host machine from inside the
compose network. The Polaris service ports (`8080`, `8081`) are the
local-dev defaults from [Getting Started](./getting-started.md). If
you run a service on a different port, edit the scrape config and
restart Prometheus, or use the runtime reload endpoint:

```bash
curl -X POST http://localhost:9090/-/reload
```

The `polaris_*` metrics themselves are currently held in tiny
in-process registries
(`apps/ingester-api/src/metrics/registry.ts`,
`packages/shared-processor/src/metrics.ts`). The Prometheus
text-format exposition that surfaces them at `/metrics` is the job of
[P10-002 Metrics Standardization](../../agents/pm/kanban/done/P10-002-metrics-standardization.md);
until that lands, the scrape will succeed but return an empty
metrics body.

## Dashboards

Grafana auto-provisions a file-backed dashboards provider that
watches [`infra/grafana/dashboards/`](../../infra/grafana/dashboards/).
On a fresh start you'll see one dashboard: **Polaris Overview
(placeholder)**, intentionally a no-op so the provider doesn't log
a 'no dashboards found' warning.

[P10-003 Grafana Dashboards](../../agents/pm/kanban/done/P10-003-grafana-dashboards.md)
replaces the placeholder with the real Polaris dashboards
(Ingestion, Processors, Destinations, ClickHouse, RabbitMQ). To add
a dashboard in the meantime, drop its JSON export into
`infra/grafana/dashboards/`. The provider syncs every 10 seconds.

To author dashboards in the Grafana UI and export them, set
`GF_USERS_ALLOW_UI_UPDATES=true` (or `allowUiUpdates: true` in
`dashboards.yml`). The default is read-only so manual UI edits don't
silently diverge from the committed JSON.

## Logs

The Loki datasource is provisioned automatically. As of P10-001, no
Polaris service is actually shipping logs to Loki — they emit Pino
JSON to stdout and the Docker container logs are the source of
truth.

[P10-004 Loki Logging Pipeline](../../agents/pm/kanban/done/P10-004-loki-logging-pipeline.md)
wires the structured logs through the OTel collector's `loki`
exporter (already configured in [`infra/otel/collector.yaml`](../../infra/otel/collector.yaml)).
Until that lands, use `docker compose logs -f <service>` for
log tailing.

## Tracing

The collector accepts OTLP traces today but does not export them
anywhere — the collector config in [`infra/otel/collector.yaml`](../../infra/otel/collector.yaml)
has a commented `traces` pipeline waiting for a Tempo/Jaeger task.
Adding either is a follow-up beyond the P10 task set; the platform
runs fine without it.

## Default credentials

Grafana's default `admin` / `admin` login is local-only and printed
in this doc on purpose. Production Grafana runs behind an SSO
frontproxy with no local admin user; the production deployment is
not derived from this compose file. See
[Observability and Operations](../architecture/08-observability-and-operations.md#observability-target).

If you want a non-default password locally (e.g. you bind the
Grafana port to a non-loopback interface), export the override
before bringing the stack up:

```bash
GRAFANA_ADMIN_PASSWORD='changeit' \
  docker compose -f docker-compose.observability.yml up -d grafana
```

## Downstream P10-* surface ownership

| Task                                                                                     | Owns                                                                            |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| P10-001 (this task)                                                                      | Compose file, infra configs, this doc.                                          |
| [P10-002 Metrics Standardization](../../agents/pm/kanban/done/P10-002-metrics-standardization.md) | Actual `polaris_*` metric names, label conventions, `/metrics` exposition.       |
| [P10-003 Grafana Dashboards](../../agents/pm/kanban/done/P10-003-grafana-dashboards.md)      | Real dashboards in `infra/grafana/dashboards/`.                                  |
| [P10-004 Loki Logging Pipeline](../../agents/pm/kanban/done/P10-004-loki-logging-pipeline.md) | Pino → OTLP → Loki wiring, label extraction, derived fields in Grafana.          |
| [P10-005 Alerts and Runbooks](../../agents/pm/kanban/done/P10-005-alerts-and-incident-runbooks.md)        | Prometheus alerting rules in `infra/prometheus/rules/`, Alertmanager config.      |
| [P10-006 DLQ Triage Runbook](../../agents/pm/kanban/done/P10-006-dlq-triage-runbook.md)      | The operator runbook for working DLQs end to end.                                |

## Troubleshooting

| Symptom                                                                          | Likely cause                                                                                          | Fix                                                                                                                                       |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `docker compose ... up` fails with `network polaris not found`                   | Started the observability overlay alone without ever bringing the core stack up.                       | Run `docker compose up -d` against the root `docker-compose.yml` first, or start both files together as shown above.                       |
| Prometheus shows scrape targets `DOWN` for `polaris-ingester` / `sync-identity` | The matching Polaris service isn't running on the host, or it bound to a non-default port.            | Start the service per [Getting Started](./getting-started.md), or edit `infra/prometheus/prometheus.yml` and `curl -X POST http://localhost:9090/-/reload`. |
| Prometheus scrape succeeds but returns no `polaris_*` series                     | P10-002 hasn't landed yet. The in-process registries exist but the `/metrics` exposition is a stub.    | Track P10-002. The compose stack is correct; the metric body itself is the downstream task.                                                |
| Grafana 'no dashboards found' warning in logs                                     | The placeholder dashboard JSON was deleted without a replacement.                                      | Re-add a JSON file under `infra/grafana/dashboards/`, or wait for P10-003.                                                                  |
| Loki shows no streams                                                            | No Polaris service is shipping logs yet (P10-004 territory).                                           | Expected today. Use `docker compose logs -f <service>` for the live tail.                                                                  |
| `host.docker.internal` not resolving from inside the compose network             | Old Linux Docker without the gateway hostname feature.                                                 | Add `extra_hosts: ["host.docker.internal:host-gateway"]` to the relevant service in the overlay, or run the Polaris service inside the compose network with its container name as the target. |
| OTLP intake silently drops data                                                  | `OTEL_EXPORTER_OTLP_ENDPOINT` points at the wrong port (4317 gRPC vs 4318 HTTP).                       | Match the protocol env var (`OTEL_EXPORTER_OTLP_PROTOCOL=grpc` for 4317, `http/protobuf` for 4318).                                          |

## See also

- [Architecture: Observability and Operations](../architecture/08-observability-and-operations.md) — the binding spec.
- [Getting Started](./getting-started.md) — local development setup.
- [CI](./ci.md) — quality gates and the integration workflow.
