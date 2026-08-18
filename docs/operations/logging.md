# Logging — Local Loki Pipeline

Operators use this guide to tail Polaris service logs through the
local Loki + Grafana stack, search them with LogQL, and reason about
the label set the platform commits to.

Binding architecture references:

- [Observability and Operations](../architecture/08-observability-and-operations.md)
- [Engineering Standards — Logging](../architecture/09-engineering-standards.md)

The matching infrastructure surfaces live at:

- [`infra/loki/loki.yaml`](../../infra/loki/loki.yaml) — single-binary
  Loki config, filesystem chunks, 7d retention.
- [`infra/loki/promtail-config.yaml`](../../infra/loki/promtail-config.yaml)
  — Docker SD tail of Polaris containers; parses Pino JSON; promotes
  the four sanctioned labels.
- [`infra/grafana/provisioning/datasources/loki.yaml`](../../infra/grafana/provisioning/datasources/loki.yaml)
  — Grafana Loki datasource + derived-field chips for `event_id`,
  `request_id`, `replay_job_id`, `processor_name`, `consumer_name`.
- [`docker-compose.observability.yml`](../../docker-compose.observability.yml)
  — Loki + promtail + Grafana services. The core `docker-compose.yml`
  has no dependency on this file.

The shared application logger that emits these lines lives at
[`packages/shared-logger/`](../../packages/shared-logger/). Redaction
defaults live in
[`packages/shared-logger/src/redaction.ts`](../../packages/shared-logger/src/redaction.ts).

## Loki is optional

The Polaris core data path is `rabbitmq + postgres + redis + clickhouse`
and runs from `docker-compose.yml` alone. The optional overlay at
`docker-compose.observability.yml` adds Loki + promtail. No service in
the core compose depends on Loki or promtail. If Loki is down,
services continue to:

- accept ingest requests,
- consume from RabbitMQ,
- write to ClickHouse / PostgreSQL,
- emit Pino JSON to stdout exactly as before.

The only thing the operator loses with Loki down is the centralised
query surface. The Docker engine still keeps each container's stdout,
so `docker compose logs -f <service>` remains a working fallback.

## Starting the pipeline

```bash
# Core data path + observability overlay (Prometheus, Grafana, Loki,
# promtail, OTel collector).
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d

# Just Loki + promtail on top of an already-running core stack.
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d loki promtail

# Validate the merged compose without starting containers.
docker compose -f docker-compose.yml -f docker-compose.observability.yml config
```

Promtail registers itself with Loki on first push. After ~10 seconds
the Grafana **Explore** view at <http://localhost:3000/explore>
(datasource: `Loki`) shows live container logs.

To stop just promtail (e.g. you want Loki up but the ingest tail
paused while debugging a noisy container):

```bash
docker compose -f docker-compose.observability.yml stop promtail
```

## What promtail tails

Promtail uses Docker service discovery, filtered to the
`com.docker.compose.project=polaris` label. That picks up every
container started by `docker-compose.yml` and
`docker-compose.observability.yml`:

- Polaris services that emit Pino JSON via `@polaris/shared-logger`
  (ingester, processors, consumers, control-plane).
- Infrastructure containers that emit plaintext (`rabbitmq`,
  `postgres`, `redis`, `clickhouse`).

The pipeline stages in [`infra/loki/promtail-config.yaml`](../../infra/loki/promtail-config.yaml)
try to parse each line as JSON. If the line is JSON, fields used as
labels (`level`, `project_id`) are extracted and the Pino `time` field
becomes the Loki entry timestamp. If the line is plaintext, the JSON
stage records `__error__` and the line passes through unparsed, using
the Docker engine timestamp.

Both kinds of lines end up in Loki under the same `{service=...}`
stream so a single LogQL query can see infra and service logs
together.

## Label set and cardinality posture

Polaris commits to **four** Loki labels. Adding more is a change to
this document, the promtail config, and the dashboards.

| Label        | Cardinality                            | Source                                                                                  |
| ------------ | -------------------------------------- | --------------------------------------------------------------------------------------- |
| `service`    | ~20 (services + infra)                 | `com.docker.compose.service` container label, equals the logger's `service` binding.    |
| `env`        | 3-5 (`local`, `dev`, `staging`, ...)   | Static label set in promtail config. Matches the logger's `env` binding.                |
| `level`      | 6 (Pino levels)                        | Parsed out of the Pino JSON `level` field.                                              |
| `project_id` | bounded by project count, ~hundreds    | Parsed out of the Pino JSON `project_id` field. Empty for infra and pre-project lines.  |

Everything else stays in the log line body and is queryable with
LogQL `| json` extraction:

| Field                           | Why it is NOT a label                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| `event_id`                      | UUIDv7 per event — unbounded, would blow up the index.                                |
| `request_id`                    | UUIDv7 per HTTP request — unbounded.                                                  |
| `trace_id` / `span_id`          | Trace IDs, unbounded.                                                                 |
| `offset`, `partition`           | Stream coordinates, high cardinality across streams.                                    |
| `processor_name`, `processor_version`, `consumer_name`, `consumer_version` | Bounded but not needed for stream-level routing; cheaper as line content.   |
| `replay_job_id`, `destination_id`, `source_id` | High cardinality; queried by grep, not by stream.                       |

The shared-logger reference for these standard fields is
[`packages/shared-logger/src/types.ts`](../../packages/shared-logger/src/types.ts)
(`StandardLogFields`).

## Redaction posture

Redaction lives in the application logger
([`packages/shared-logger/src/redaction.ts`](../../packages/shared-logger/src/redaction.ts),
`DEFAULT_REDACTION_PATHS`). It covers passwords, authorization headers,
cookies, tokens, card data, private keys, and raw event payloads.

Loki sees what the logger emits. **Do not** add Loki-side `replace`
stages or grafana-side masks as a substitute for in-app redaction:

- They would be a silent second copy of the policy that drifts from
  the source list.
- They would mask the symptom (data in Loki) and leave the cause
  (data left the service) unaddressed.
- They would not protect the `docker compose logs` fallback path,
  which reads the same stdout stream.

If a new sensitive field name shows up in lines, extend
`DEFAULT_REDACTION_PATHS` (or pass `additionalRedactionPaths` to
`createLogger`). Promtail and Loki do not need to change.

## Example LogQL queries

Run these in Grafana **Explore** with the **Loki** datasource
selected, or via curl against
`http://localhost:3100/loki/api/v1/query_range`.

### All errors from one service in the last hour

```logql
{service="ingester-api", level="error"}
```

### All logs for one project

```logql
{project_id="0193e7a8-3b8c-7c4f-b3ef-projectid123"}
```

Add a service filter to narrow further:

```logql
{project_id="0193e7a8-3b8c-7c4f-b3ef-projectid123", service="sync-enrichment-runjector"}
```

### A specific `event_id` (line-content grep, not a label)

`event_id` is not a label. Use LogQL `|=` for a fast substring scan
or `| json` for structured extraction:

```logql
{service=~"ingester-api|sync-identity|sync-enrichment|.*-consumer"}
  |= "018f1b9e-7b50-7b12-9a2e-eventid01234"
```

Or extract structurally and filter:

```logql
{service=~".+"} | json | event_id="018f1b9e-7b50-7b12-9a2e-eventid01234"
```

### 4xx responses for one event_id

```logql
{service="ingester-api", level=~"warn|error"}
  | json
  | event_id="018f1b9e-7b50-7b12-9a2e-eventid01234"
  | status_code >= 400 and status_code < 500
```

### Publish failures from one processor

```logql
{service="sync-enrichment-runjector", level=~"warn|error"}
  | json
  | __error__=""
  | message =~ "publish.*fail|transport.*error"
```

Replace `sync-enrichment` with the specific processor name
when triaging a known offender. The `processor_name` field is also
in the line body if you want to broaden across processor variants:

```logql
{level=~"warn|error"}
  | json
  | processor_name="sessionizer"
  | message =~ "publish.*fail"
```

### Per-project ingest rejection rate

```logql
sum by (project_id) (
  rate({service="ingester-api", level=~"warn|error"}
       | json
       | message =~ "rejected" [5m])
)
```

Pivots back to Prometheus's `polaris_ingest_batch_rejected_total`
when the metric exists; useful as a sanity check that metric and log
volumes match.

### Tail one container, raw

```logql
{service="rabbitmq"}
```

Plaintext containers come through too — the JSON parse stage
records `__error__` but does not drop the line.

## When promtail itself is the problem

Promtail exposes its own status at <http://localhost:9080/targets>
when the overlay is up. Common symptoms:

| Symptom                                                | Likely cause                                                                                       | Fix                                                                                                                       |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| No logs at all in Grafana Explore                      | Promtail can't reach the Docker socket, or Loki rejected the push.                                  | Check `docker compose logs promtail`; verify `/var/run/docker.sock` mount and that Loki is healthy.                       |
| Some services missing from `{service=~".+"}`           | New compose service started without the `polaris` compose project label.                            | Confirm the container was started via `docker compose -f docker-compose.yml -f ...`, not `docker run` directly.            |
| Lines arrive but `level` / `project_id` labels missing | The Pino JSON `level` / `project_id` fields are absent, or the line wasn't JSON.                    | Inspect the raw line in Loki; check the emitting service's logger context (`withRequest`, `withProcessor`, etc.).         |
| Loki rejects pushes with `entry too far behind`        | The Pino `time` field is older than `reject_old_samples_max_age` (168h / 7d) in `infra/loki/loki.yaml`. | Usually means a test fixture or replay backfilled old data. Don't disable old-sample rejection; backfill via a replay job. |

When in doubt, `docker compose logs -f promtail` shows the per-target
discovery loop and per-line errors.

## What this guide does not cover

- **Production Loki.** This pipeline is local-dev shaped (filesystem
  chunks, 7d retention, no tenant separation, no SSO). Production
  runs distributed Loki with object storage and SSO Grafana; that
  deployment is owned by the infra layer, not this compose.
- **Trace correlation.** The Grafana derived-field chips for
  `event_id` / `request_id` are display-only. Real trace lookup
  waits for a Tempo/Jaeger task; the existing OTel collector
  (`infra/otel/collector.yaml`) already accepts OTLP traces but does
  not export them.
- **Alerts on log volume / error rate.** Alerting is owned by
  P10-005. The compactor + ruler scaffolding is present in
  `infra/loki/loki.yaml` but the rule set itself ships with that
  task.
