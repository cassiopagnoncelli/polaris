# Grafana Dashboards

This document is the operator-facing index to the v1 Polaris Grafana dashboards
shipped by **P10-003** (Grafana Dashboards). Each dashboard is a static JSON
file under [`infra/grafana/dashboards/`](../../infra/grafana/dashboards), loaded
into Grafana at startup by the dashboards provider in
[`infra/grafana/provisioning/dashboards/dashboards.yml`](../../infra/grafana/provisioning/dashboards/dashboards.yml).
The Prometheus datasource is auto-provisioned with UID `polaris-prometheus`
(see [`infra/grafana/provisioning/datasources/datasources.yml`](../../infra/grafana/provisioning/datasources/datasources.yml));
each dashboard exposes a `${DS_PROMETHEUS}` variable so the UID can be swapped
at startup for staging / production stacks.

The dashboards run on top of the optional observability compose
([`docker-compose.observability.yml`](../../docker-compose.observability.yml)).
Start it locally with:

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
# Validate the merged compose without starting:
docker compose -f docker-compose.yml -f docker-compose.observability.yml config
```

Grafana lands at <http://localhost:3000> (admin/admin, local-only).

## Dashboard inventory

| Dashboard | UID | Purpose | Source metrics package |
|---|---|---|---|
| [Polaris — Ingestion](#ingestion) | `polaris-ingestion` | Accept/reject rate, reject reason breakdown, dedupe, origin/rate-limit, redactions, deprecated schema usage | [`apps/ingester-api/src/metrics/registry.ts`](../../apps/ingester-api/src/metrics/registry.ts) |
| [Polaris — RabbitMQ](#rabbitmq) | `polaris-rabbitmq` | Native broker scrape (`/public_metrics`) + Polaris-side publish-failure proxy | [`infra/prometheus/prometheus.yml`](../../infra/prometheus/prometheus.yml), [`apps/ingester-api/src/metrics/registry.ts`](../../apps/ingester-api/src/metrics/registry.ts) |
| [Polaris — Processors](#processors) | `polaris-processors` | Per-processor consumed/emitted/failed/retry/DLQ rates + lag/duration gauges | [`packages/shared-processor/src/metrics.ts`](../../packages/shared-processor/src/metrics.ts) |
| [Polaris — Spine](#spine) | `polaris-spine` | The two spine stages (identity resolution, enrichment): throughput, lag, resolution mix, merge rate, and the safeguard/degradation counters both stages fail open into | [`packages/shared-processor/src/metrics.ts`](../../packages/shared-processor/src/metrics.ts) |
| [Polaris — Destinations](#destinations) | `polaris-destinations` | Per-vendor delivery success/failure, error_class breakdown, drops, delivery duration | [`packages/shared-destinations/src/metrics.ts`](../../packages/shared-destinations/src/metrics.ts) |
| [Polaris — ClickHouse](#clickhouse) | `polaris-clickhouse` | ClickHouse sink ingest lag, MV-failure proxy, MV-failure proxy, escape-hatch audit | [`packages/shared-clickhouse/src/raw.ts`](../../packages/shared-clickhouse/src/raw.ts), [`packages/shared-processor/src/metrics.ts`](../../packages/shared-processor/src/metrics.ts) |

The per-project topic-isolation dashboards from **P11-008**
(`polaris-per-project-throughput`, `polaris-per-project-schema`,
`polaris-per-project-lag`, `polaris-per-partition-skew`) are shipped in the
same directory and are owned by the [topic-isolation cutover
runbook](./topic-isolation-cutover.md). They are not re-documented here.

## Ingestion

**File:** [`infra/grafana/dashboards/polaris-ingestion.json`](../../infra/grafana/dashboards/polaris-ingestion.json)
**UID:** `polaris-ingestion`
**Default range:** last 6 hours

Panels and the metric each uses:

| Panel | Metric expression |
|---|---|
| Accept vs reject rate (5m) | `sum(rate(polaris_ingest_batch_accepted_total[5m]))`; `sum(rate(polaris_ingest_batch_rejected_total[5m]))` |
| Reject ratio (15m) | `polaris_ingest_batch_rejected_total / (accepted + rejected)` over 15m |
| Reject reason breakdown (5m) | `sum by (reason) (rate(polaris_ingest_batch_rejected_total[5m]))` — reason ∈ `unsupported_schema_version`, `schema_version_sunset`, `unknown_event`, `invalid_properties`, `invalid_envelope`, `forbidden_field_rejected`, `duplicate`, `publish_failed`, `invalid_request` (from `packages/shared-schemas/src/reason-codes.ts`) |
| Short-window dedupe (5m) | `polaris_ingest_dedupe_hit_total`, `polaris_ingest_dedupe_skipped_total` |
| Edge controls (5m) | `polaris_ingest_origin_rejected_total`, `polaris_ingest_rate_limit_rejected_total`, `polaris_ingest_rate_limit_skipped_total` |
| Pattern-based redactions (5m) | `sum by (pattern, reason) (rate(polaris_ingest_redacted_pattern_total[5m]))` |
| Deprecated `schema_version` usage (5m) | `sum by (event, schema_version) (rate(polaris_ingest_deprecated_schema_version_total[5m]))` |
| Accept latency p50/p99/p999 (5m) | `histogram_quantile(0.99, sum by (le) (rate(polaris_ingest_accept_duration_seconds_bucket[5m])))` |

**Known gaps:**

- **No request-rate metric.** The v1 ingester does not emit an HTTP-level
  request rate. Accept/reject sum is used as the proxy.
- **No body-size distribution.** No histogram for envelope body size; the
  next round of metrics could add one alongside the accept-duration
  histogram from CSH8YAL6.

## RabbitMQ

**File:** [`infra/grafana/dashboards/polaris-rabbitmq.json`](../../infra/grafana/dashboards/polaris-rabbitmq.json)
**UID:** `polaris-rabbitmq`
**Default range:** last 6 hours

Panels and the metric each uses:

| Panel | Metric expression |
|---|---|
| Broker scrape health | `up{job="polaris-rabbitmq"}` |
| Publish rate per stream (5m, msg/s) | `sum by (queue) (rate(rabbitmq_queue_messages_published_total[5m]))` |
| Deliver rate per stream (5m, msg/s) | `sum by (queue) (rate(rabbitmq_queue_messages_delivered_total[5m]))` |
| Retry / DLQ queue depth (messages) | `sum by (queue) (rabbitmq_queue_messages_ready{queue=~".*\\.(retry\\..*|redeliver|dlq)"})` |
| Unroutable publishes (5m) | `sum(rate(rabbitmq_channel_messages_unroutable_dropped_total[5m]))` |
| Publish failure rate (proxy) | `sum(rate(polaris_ingest_batch_rejected_total{reason="publish_failed"}[5m]))` |
| Per-family processor lag (authoritative, ms) | `max by (topic_family, processor_name) (polaris_processor_lag_ms_last)` |

**Known gaps:**

- **Per-queue series need the detailed scrape endpoint.** The Polaris
  scrape config in
  [`infra/prometheus/prometheus.yml`](../../infra/prometheus/prometheus.yml)
  targets `polaris-rabbitmq:15692/metrics/detailed` with the
  `queue_coarse_metrics` / `queue_metrics` families. The default
  aggregated `/metrics` endpoint collapses every stream into one number,
  which makes "which family is backing up?" unanswerable. If a panel
  shows no data, check that the `family` params survived a config edit.

- **There is no consumer-group lag metric, by construction.** RabbitMQ
  streams do not track per-consumer position server-side — that is why
  Polaris owns checkpoints in `transport_checkpoints`. The authoritative
  lag signal is `polaris_processor_lag_ms_last` (event-time based,
  emitted by every processor), which is what the alert rules page on.
  For "is anyone reading this stream at all", use
  `rabbitmq_queue_consumers`.

- **Unroutable publishes are a topology alarm, not a capacity one.** A
  non-zero rate means something is publishing to an exchange with no
  binding. See
  [runbook-rabbitmq-topology.md](runbook-rabbitmq-topology.md).
- **No Polaris-side publish-failure counter.** The proxy is the ingester's
  per-batch reject counter with `reason="publish_failed"`. A dedicated
  `polaris_ingest_publish_failed_total` would let us split publish vs
  serializer vs batch-flush failures; not in v1.
- **No fleet-wide broker health roll-up.** `up{job=...}` is the v1 sentinel.

## Processors

**File:** [`infra/grafana/dashboards/polaris-processors.json`](../../infra/grafana/dashboards/polaris-processors.json)
**UID:** `polaris-processors`
**Default range:** last 6 hours

The `$processor_name` template variable picks one of the five v1 processors:
`analytics-projector`, `identity-resolver`, `sessionizer`, `geoip-enricher`,
`attribution-engine`. `All` shows the fleet aggregate.

Panels and the metric each uses:

| Panel | Metric expression |
|---|---|
| Events consumed (5m) | `sum by (processor_name) (rate(polaris_processor_events_consumed_total[5m]))` |
| Events emitted (5m) | `sum by (processor_name) (rate(polaris_processor_events_emitted_total[5m]))` |
| Failures by reason (5m) | `sum by (processor_name, reason) (rate(polaris_processor_events_failed_total[5m]))` |
| Retry and DLQ rates (5m) | `polaris_processor_events_retry_total`, `polaris_processor_events_dlq_total` |
| Skipped by reason (5m) | `sum by (processor_name, project_id, reason) (rate(polaris_processor_events_skipped_total[5m]))` |
| Per-processor lag (ms, last observed) | `max by (processor_name, partition) (polaris_processor_lag_ms_last)` |
| Per-message handler duration (ms, last observed) | `max by (processor_name) (polaris_processor_handler_duration_ms_last)` |
| DLQ growth rate by processor (15m) | `sum by (processor_name) (rate(polaris_processor_events_dlq_total[15m]))` |

**Skips are not failures.** `polaris_processor_events_skipped_total` counts
events a processor acknowledged without acting on.
`reason="processor_disabled"` means an operator disabled that processor for
that `(project_id, environment)` — the intended answer to "why did this
project's derived events stop", and the reason that question is answerable
without reading logs. Do not alert on it; it is a decision, not an incident.

**Latency.** `polaris_processor_lag_seconds` and
`polaris_processor_handler_duration_seconds` are histograms (CSH8YAL6); the
dashboard's bottom row uses `histogram_quantile(0.99, ...)` over the
`_bucket` series for real p50/p99 panels. The legacy `_ms_last` gauges remain
in place during the transition so existing `max`/`lastNotNull` panels keep
working — favour the histogram panels for new consumers.

**Known gaps:**

- **DLQ growth is a rate, not a backlog gauge.** For a true backlog count,
  query `polaris_dlq_records` directly via the
  [destination DLQ triage runbook](./destination-dlq-triage.md). A dedicated
  per-processor DLQ-backlog metric would let this dashboard show "events
  waiting in DLQ"; not in v1.

## Destinations

**File:** [`infra/grafana/dashboards/polaris-destinations.json`](../../infra/grafana/dashboards/polaris-destinations.json)
**UID:** `polaris-destinations`
**Default range:** last 6 hours

The `$vendor` template variable picks one of the five v1 destination consumers:
`webhook-sink`, `meta-capi`, `tiktok`, `ga4`, `braze`. `All` shows the fleet aggregate.

Panels and the metric each uses:

| Panel | Metric expression |
|---|---|
| Delivery success rate per vendor (5m) | `sum by (vendor) (rate(polaris_destination_events_delivered_total[5m]))` |
| Delivery success ratio per vendor (15m) | `delivered / (delivered + failed)` over 15m |
| Failure breakdown by `error_class` (5m) | `sum by (vendor, reason) (rate(polaris_destination_events_failed_total[5m]))` — `reason` ∈ `consent`, `identity`, `mapping`, `auth`, `rate_limit`, `transient`, `permanent`, `timeout`, `policy` (from `DELIVERY_RECORD_ERROR_CLASSES` in `packages/shared-destinations/src/db/delivery-records.ts`) |
| Retry and DLQ rates per vendor (5m) | `polaris_destination_events_retry_total`, `polaris_destination_events_dlq_total` |
| Drops by reason (5m) | `sum by (vendor, reason) (rate(polaris_destination_events_dropped_total[5m]))` |
| Delivery duration (ms, last observed) | `max by (vendor) (polaris_destination_delivery_duration_ms_last)` |
| Rate-limit lease wait (ms, last observed) | `max by (vendor) (polaris_destination_rate_limit_wait_ms_last)` |
| Delivery duration p50/p99 per vendor (5m) | `histogram_quantile(0.99, sum by (le, vendor) (rate(polaris_destination_delivery_duration_seconds_bucket[5m])))` |

**Latency.** `polaris_destination_delivery_duration_seconds` and
`polaris_destination_rate_limit_wait_seconds` are histograms (CSH8YAL6); the
p50/p99 panel uses them via `histogram_quantile`. The legacy `_ms_last`
gauges remain in place during the transition for the `max` panel.

**Known gaps:**

- **DLQ growth is a rate, not a backlog count.** The
  [destination DLQ triage runbook](./destination-dlq-triage.md) covers
  per-destination backlog inspection from `polaris_dlq_records`.

## ClickHouse

**File:** [`infra/grafana/dashboards/polaris-clickhouse.json`](../../infra/grafana/dashboards/polaris-clickhouse.json)
**UID:** `polaris-clickhouse`
**Default range:** last 6 hours

Panels and the metric each uses:

| Panel | Metric expression |
|---|---|
| ClickHouse ingestion lag (s) | `max by (table) (polaris_clickhouse_sink_lag_seconds)` |
| Analytics insert rate (5m, ops; proxy) | `sum(rate(polaris_processor_events_emitted_total{processor_name="analytics-projector"}[5m]))` |
| Materialized-view / insert failures (5m, proxy) | `sum by (reason) (rate(polaris_processor_events_failed_total{processor_name="analytics-projector"}[5m]))` |
| Operator escape-hatch raw query rate (5m, audit) | `sum by (caller) (rate(polaris_clickhouse_operator_raw_query_total[5m]))` |
| Inserter DLQ rate (15m) | `sum(rate(polaris_processor_events_dlq_total{processor_name="analytics-projector"}[15m]))` |
| Query rate by table / query p99 / projection freshness | placeholder — see gap below |

**Known gaps (largest in v1):**

- **ClickHouse is not scraped natively in v1.** The `clickhouse` service
  in [`docker-compose.yml`](../../docker-compose.yml) does not expose
  `/metrics`; no `clickhouse_exporter` is wired in
  [`docker-compose.observability.yml`](../../docker-compose.observability.yml);
  no scrape stanza for ClickHouse exists in
  [`infra/prometheus/prometheus.yml`](../../infra/prometheus/prometheus.yml).
  Until that lands, **every native ClickHouse signal** is proxied through
  the **analytics-projector** processor (which is Polaris's writer into
  `analytics.events`).
- **No materialized-view `failed_state` count.** The proxy is
  `polaris_processor_events_failed_total{processor_name="analytics-projector"}`,
  which is the Polaris-side view of insert failures, not ClickHouse's
  internal MV failure ledger.
- **No query-rate-by-table panel.** Needs ClickHouse's built-in
  `ClickHouseProfileEvents_Query` and a database/table label split, which
  requires the native exporter.
- **No query p99 latency.** Needs
  `histogram_quantile(0.99, rate(ClickHouseProfileEvents_QueryTimeMicroseconds[5m]))`
  via the native exporter.
- **No projection table freshness signal.** Projections like
  `event-daily-counts` need a `freshness_age_ms` gauge that no current
  emitter produces.

## Spine

**File:** `infra/grafana/dashboards/polaris-spine.json` · **UID:** `polaris-spine` · **Default range:** last 6h

The two stages of the main pipeline that resolve and enrich every event:
`raw.events → sync-identity-resolver → identified.events → sync-enrichment-runtime → resolved.events`.

**Read the outcome panels first.** Both stages fail open by design — a
missing profile row, an over-size trait snapshot, an absent geo database
and an event with no IP all produce a well-formed event with null-ish
blocks. None raises the failure counter, so a silent degradation is
invisible in throughput and error panels and visible only in
`polaris_processor_outcome_total`.

| Panel | Metric expression |
| --- | --- |
| Throughput by stage (5m) | `sum by (processor_name) (rate(polaris_processor_events_consumed_total{...}[5m]))` and the `_emitted_` sibling |
| Failures by stage (5m) | `sum by (processor_name, reason) (rate(polaris_processor_events_failed_total{...}[5m]))` |
| Consumer lag by stage | `max by (processor_name, partition) (polaris_processor_lag_ms_last{...})` |
| Handler duration p99 | `histogram_quantile(0.99, sum by (processor_name, le) (rate(polaris_processor_handler_duration_seconds_bucket{...}[5m])))` |
| Identity resolution mix (5m) | `sum by (outcome) (rate(polaris_processor_outcome_total{processor_name="sync-identity-resolver"}[5m]))` — outcome ∈ `created`, `bound`, `merged`, `unidentified` |
| Merge rate (5m) | the same series filtered to `outcome="merged"` |
| Enrichment outcomes (5m) | `sum by (outcome) (rate(polaris_processor_outcome_total{processor_name="sync-enrichment-runtime"}[5m]))` — outcome ∈ `traits:*`, `geo:*` |
| Safeguards and degradations (15m) | `sum by (processor_name, reason) (rate(polaris_processor_events_skipped_total{...}[15m]))` — reason ∈ `merge_suspended`, `link_rejected_denylisted`, `link_rejected_identifier_cap`, `traits_over_cap`, `profile_missing` |

**Known gaps.**

- `merge rate` counts merges the stage PERFORMED. Merges it refused are
  on the safeguards panel as `merge_suspended`; a storm shows as the
  first falling while the second rises.
- Neither stage sets `concrete_topic` on its metric labels (no processor
  does — see the Processors section), so panels cannot break down by
  concrete topic.
- The enrichment stage's `geo:miss` does not distinguish "the database
  had no record" from "no database is wired". The `geo.source` field on
  the emitted event does (`no_lookup` vs a version-stamped backend id),
  but that is a ClickHouse question, not a Prometheus one.

## Adding a new dashboard

1. Author the JSON file under `infra/grafana/dashboards/`. The dashboards
   provider (`infra/grafana/provisioning/dashboards/dashboards.yml`) picks
   up new files within 10 seconds of the next sync.
2. Reference the datasource as `${DS_PROMETHEUS}` (with a templating entry
   declaring the variable) so the UID is swappable at startup.
3. Reference real metric names — verify against the registries listed at
   the top of this document. Do **not** invent metric names.
4. Sanity-check the JSON parses: `jq . infra/grafana/dashboards/<file>.json`.
5. Add an entry to the table at the top of this file.

## See also

- [Observability and Operations](../architecture/08-observability-and-operations.md) — canonical metric vocabulary and SLO posture.
- [Delivery Roadmap](../implementation/delivery-roadmap.md) — what "v1 operations" means.
- [Destination DLQ Triage](./destination-dlq-triage.md) — backlog inspection that complements the rate panels here.
- [Topic Isolation Cutover](./topic-isolation-cutover.md) — owns the four per-project topic-isolation dashboards in the same directory.
