# Codex Instructions for Polaris

Use these instructions when generating or modifying Polaris code.

## Names

- Polaris is the event infrastructure platform.
- Redpanda is the streaming backbone.
- Do not call the platform Panda in generated docs or code.

## Core Architecture

Generate code around this path:

```text
SDKs/producers
  -> Fastify ingester
  -> Redpanda raw.events
  -> versioned processors
  -> Redpanda derived topics
  -> destination consumers
  -> ClickHouse Kafka Engine
```

## Hard Rules

- Do not enrich at ingress.
- Do not call external destination APIs from the ingester.
- Do not expose Redpanda directly to browser clients.
- Keep SDKs thin.
- Keep raw events immutable.
- Keep processors and consumers independent and versioned.
- Treat destination consumers as protocol translators.
- Feed ClickHouse through Kafka Engine from `analytics.events`.
- Persist Kafka Engine rows before querying.
- Preserve replayability as a primary architectural constraint.

## File-Heavy, DB-Light

Semantic platform truth belongs in files and code:

- event catalog
- event schemas
- Zod validators
- destination mapping code
- processor code
- processor manifests
- SQL DDL/migrations
- docs

PostgreSQL stores mutable runtime/control state:

- API key hashes and metadata
- runtime enable/disable state
- replay jobs
- processor runs
- destination instances
- delivery records
- audit records

Do not make PostgreSQL redefine event schemas, destination mappings, processor semantics, or canonical event meaning.

## Expected Repository Shape

Prefer this monorepo shape unless the user asks for a different layout:

```text
apps/
  ingester-api/

packages/
  web-sdk/
  node-sdk/
  shared-schemas/
  shared-kafka/
  shared-logger/
  shared-config/
  shared-secrets/

catalog/
  events/

processors/
  identity-resolver/
    v1/
  sessionizer/
    v1/
  geoip-enricher/
    v1/
  attribution-engine/
    v1/

consumers/
  meta-capi/
    v1/
  ga4/
    v1/
  tiktok/
    v1/
  braze/
    v1/

infra/
  docker/
  redpanda/
  clickhouse/
  prometheus/
  grafana/
  loki/

sql/
  clickhouse/

docs/
```

## Engineering Defaults

Use these defaults unless a task explicitly changes them:

- strict TypeScript
- current Active LTS Node.js pinned at scaffold time
- ESM-first packages/services
- pnpm workspaces
- package scripts first, no Turborepo/Nx in v1
- Kysely for PostgreSQL queries
- SQL-first PostgreSQL migrations, defaulting to dbmate after implementation-time review
- Vitest for tests
- UUIDv7 for platform-generated IDs
- UTC timestamps everywhere
- RFC 7807 Problem Details for request-level HTTP errors
- Pino for JSON logs
- shared Zod-validated runtime config
- KafkaJS through a thin `shared-kafka` package
- ClickHouse SQL files plus official ClickHouse JavaScript client
- OpenAPI generated from Fastify/Zod route schemas
- Biome for formatting/linting
- compiled JavaScript in slim Node production containers
- Fastify with a thin shared service bootstrap package

Keep dependencies boring and minimal. Prefer already chosen libraries before introducing alternatives.

## Event Contract

Use a rigid canonical envelope. Reject unknown top-level fields. Stamp trusted metadata from API keys.

Required platform fields include:

```text
event_id
event
schema_version
project_id
environment
occurred_at
ingested_at
source
identity
context
properties
```

`consent` and `privacy` may be present but are informational in v1.

Normal events must be registered and validated by code-backed Zod schemas. `experimental.*` events may be looser but must not feed durable production semantics without promotion.

## SDKs

Build `packages/web-sdk` and `packages/node-sdk` first. Defer React, Ruby, and mobile SDKs.

SDK v1 exposes:

```ts
track(event, properties, options?)
identify(customerId, traits?)
reset(options?)
flush()
```

Rules:

- SDKs are transport and identity/session helpers only.
- No automatic page tracking by default.
- Page views are explicit `track("page.viewed", ...)` calls.
- Browser SDK supports layered identity persistence: first-party cookie, localStorage mirror, sessionStorage fallback, memory fallback.
- Browser SDK must not use third-party cookies or fingerprinting.
- WebView/in-app browser support is important but best-effort.
- Browser sessions rotate after 30 minutes of inactivity.
- Campaign/click changes are captured in context, not used to rotate sessions.
- Web SDK uses offline-first lifecycle-aware queueing.
- Web queue prefers IndexedDB, then localStorage, then memory.
- First 15 seconds after SDK init use eager flush mode.
- Steady mode flushes every 5 seconds by default.
- Queue priorities are `low`, `normal`, `high`; default is `normal`.
- Queue overflow drops oldest low-priority events first, then normal, then high.
- `reset()` clears customer identity, rotates session, and rotates anonymous identity by default.
- `reset({ anonymous: false })` keeps anonymous identity.
- Node SDK uses memory queue by default with pluggable durable queue adapters.
- Node SDK exposes explicit `flush()` and `close()` lifecycle.
- SDKs validate only basic envelope/client constraints; ingester remains authoritative for event schemas.
- SDK diagnostics use optional callbacks and debug logging, not automatic diagnostic events in v1.

## Ingestion

The ingester should:

- authenticate API keys
- resolve project/environment/source
- validate envelopes and properties
- enforce forbidden-field guardrails
- perform 24-hour event ID dedupe where cheap
- publish valid events to Redpanda
- return per-event batch results

It should not:

- enrich
- resolve identity
- attribute
- call vendors
- aggregate analytics

## Processors

Processor versions are immutable in semantic behavior.

Any change that can alter emitted event meaning, fields, identity links, attribution outcomes, filtering behavior, or output schema requires a new processor version.

Processor runs must record:

```text
processor_name
processor_version
git_sha
config_hash
runtime_settings_hash
input_topic
output_topic
status
timestamps
metrics
```

## Destinations

Destination mappings are code-only. PostgreSQL may store destination instances and operational knobs, but not event-to-vendor mapping semantics.

Consumers must implement:

- batching
- retries
- DLQs
- rate limits
- delivery records
- idempotency
- vendor dedupe fields where supported

Destination sends during replay are disabled by default.

## ClickHouse

Do not query Kafka Engine tables directly.

Use:

```text
Kafka Engine table
  -> analytics_ingest_log
  -> analytics_raw
  -> materialized views
  -> projection tables
```

`analytics_ingest_log` is append-only. `analytics_raw` is the deduped analytical fact table.

## Observability

Every service should emit structured JSON logs, expose Prometheus metrics, expose health/readiness endpoints, and include build/version info. Add OpenTelemetry hooks where useful.

Observability backends are preferred but optional runtime dependencies.

## MVP Direction

When implementation begins, build the first vertical slice before broad platform surface area:

```text
schema
SDK sender
ingester
raw.events
simple processor
analytics.events
ClickHouse ingest
basic query
logs/metrics
```
