# P10-001: Observability Compose

Status: Done (merged in `d5ab28f`)

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

- [x] Optional observability compose exists.
- [x] Prometheus can scrape service metrics endpoints when services are running.
- [x] Grafana is configured with local data sources where practical.
- [x] Loki/OTel config is present or clearly stubbed.
- [x] Docs show how to start optional stack.

## Checks

Run where possible:

```text
docker compose -f docker-compose.yml -f docker-compose.observability.yml config
```

## Handoff

```text
Files changed:
  docker-compose.observability.yml                            (new, root)
  infra/prometheus/prometheus.yml                             (new)
  infra/grafana/provisioning/datasources/datasources.yml      (new)
  infra/grafana/provisioning/dashboards/dashboards.yml        (new)
  infra/grafana/dashboards/polaris-overview.json              (new, placeholder)
  infra/loki/loki.yaml                                        (new)
  infra/otel/collector.yaml                                   (new)
  docs/development/observability.md                           (new)
  docs/implementation/tasks/P10-001-observability-compose.md  (status + handoff)

Commands run:
  pnpm install --frozen-lockfile
  pnpm build
  pnpm typecheck                                              (no-op-green)
  pnpm lint                                                   (no-op-green)
  pnpm format:check                                           (green after biome auto-format on the placeholder dashboard JSON)
  pnpm test                                                   (no-op-green; nothing under apps/, packages/, processors/, consumers/ touched)
  docker compose -f docker-compose.yml -f docker-compose.observability.yml config   (merged compose validates; 8 services resolved: redpanda, postgres, redis, clickhouse, prometheus, grafana, loki, otel-collector)
  node -e "yaml.parse(...)" over the 6 YAML files               (all parse)
  node -e "JSON.parse(...)" over the placeholder dashboard      (parses)

Checks passed:
  - Compose overlay shape: 4 new services (prometheus, grafana, loki, otel-collector) on the existing `polaris` bridge network. Volumes for prometheus/grafana/loki.
  - Prometheus scrape config covers self-scrape + ingester (host:8080) + analytics-projector (host:8081) + Redpanda public_metrics (polaris-redpanda:9644) + collector self-metrics. `external_labels.cluster=polaris-local` is the federation hook.
  - Grafana auto-provisions Prometheus (default) and Loki datasources, plus a file-backed dashboards provider pointed at infra/grafana/dashboards/. Default admin/admin is local-only and called out in the docs.
  - Loki single-binary local mode with 7d retention; ruler stub is in place for P10-005.
  - OTel Collector receives OTLP/gRPC + OTLP/HTTP and fans out to prometheusremotewrite (Prometheus is started with `--web.enable-remote-write-receiver`), lokiexporter, and a debug exporter. Trace pipeline is a commented placeholder pending a Tempo/Jaeger task.
  - Operator doc at docs/development/observability.md covers start commands, the four URLs, env-var wiring for OTel, where dashboards live, troubleshooting, and which downstream P10-* task owns which surface.

Known gaps:
  - Polaris services do not yet emit `polaris_*` metrics on their /metrics endpoint — the in-process registries exist (apps/ingester-api/src/metrics/registry.ts, packages/shared-processor/src/metrics.ts) but the Prometheus text-format exposition is owned by P10-002. Scrapes will succeed and return empty bodies until then.
  - No real Grafana dashboards beyond the placeholder; P10-003 replaces it.
  - No Pino -> Loki pipeline yet; P10-004 wires it through the collector's lokiexporter (already configured).
  - No Prometheus alerting rules or Alertmanager; P10-005 lands those.
  - Trace exporter intentionally absent (commented placeholder in collector.yaml).
  - The overlay assumes the `polaris` network already exists (created by docker-compose.yml). Running JUST the overlay first triggers a 'network not found' error; this is documented in observability.md troubleshooting.
  - `host.docker.internal` is used for the host-side scrape targets. On older Linux without Docker Desktop, users need `extra_hosts: ["host.docker.internal:host-gateway"]` on the relevant services (documented).
```

