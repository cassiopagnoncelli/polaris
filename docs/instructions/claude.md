# Claude Instructions for Polaris

Use these instructions when generating or modifying Polaris code.

## Names

- Polaris is the event infrastructure platform.
- RabbitMQ is the streaming backbone.
- Do not call the platform Panda in generated docs or code.

## Core Architecture

Generate code around this path:

```text
SDKs/producers
  -> Fastify ingester
  -> RabbitMQ raw.events
  -> versioned processors
  -> RabbitMQ derived topics
  -> destination consumers
  -> clickhouse-sink
```

## Hard Rules

- Do not enrich at ingress.
- Do not call external destination APIs from the ingester.
- Do not expose RabbitMQ directly to browser clients.
- Keep SDKs thin.
- Keep raw events immutable.
- Keep processors and consumers independent and versioned.
- Treat destination consumers as vendor adapters with three stages: normalize, map, deliver. Each stage is independently versioned. Shared normalization primitives live in `packages/shared-destination-normalize/`.
- Feed ClickHouse through `consumers/clickhouse-sink` from `analytics.events`.
- Persist ingested rows before querying.
- `analytics_raw` is never queried without explicit dedupe (`argMax(_version)`, `SETTINGS final = 1`, or `count(DISTINCT event_id)` shape).
- Preserve replayability within the operational retention window as a primary architectural constraint.

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
  ingester-api/                    Fastify ingestion service
  control-plane-api/               Fastify admin/control-plane API (target of the CLI)
  polaris-cli/                     polaris CLI (thin client of control-plane-api)

packages/
  web-sdk/
  node-sdk/
  shared-schemas/                  envelope + event Zod schemas
  shared-transport/                    transport port + RabbitMQ driver + stream-family resolver
  shared-logger/                   Pino setup
  shared-config/                   Zod-validated runtime config
  shared-secrets/                  argon2id hashing primitive (API keys, operator tokens)
  shared-clickhouse/               wraps @clickhouse/client; only sanctioned ClickHouse access path
  shared-destinations/             destination consumer runtime (normalize/map/deliver helpers)
  shared-destination-normalize/    vendor-agnostic normalization primitives
  shared-policy/                   forbidden-field policy evaluator
  shared-control-plane/            CLI <-> control-plane-api shared types and helpers
  shared-processor/                processor runtime helpers (manifests, run records)

catalog/
  events/                          file-backed event catalog (yaml + Zod schemas in shared-schemas)
  policy/                          forbidden-field policy and project overrides

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
  webhook-sink/
    v1/                            simplest exemplar; canonical SPEC.md reference
  meta-capi/
    v1/
  ga4/
    v1/
  tiktok/
    v1/
  braze/
    v1/
  reverse-etl/
    v1/

  Each consumer/<vendor>/v<N>/ ships:
    SPEC.md            filled from docs/implementation/templates/consumer-spec-template.md
    normalize/         vendor-specific normalization on top of shared-destination-normalize
    mappers/           per-canonical-event vendor payload mappers
    deliver/           vendor client adapter (auth, batching, retry, rate limit)
    manifest.json      versioning metadata
    test/fixtures/     golden input/output pairs per canonical event

infra/
  docker/
  rabbitmq/
  clickhouse/
  prometheus/
  grafana/
  loki/

sql/
  clickhouse/
    roles/                         polaris_service / polaris_operator definitions + grants
    projections/                   one .sql file per projection table
    materialized-views/            MVs that feed projections (argMax pattern)
    <ddl files>                    ingestion interface table, analytics_ingest_log, analytics_raw

db/
migrations/                        SQL-first PostgreSQL migrations (dbmate by default)

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
- amqplib behind the `shared-transport` port
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

### Schema evolution

`schema_version` is a per-event integer. Multiple versions of an event coexist in the catalog. In-place changes are permitted only when every previously-valid event remains valid (additive optionals, widening ranges, etc.). Anything that breaks validation, meaning, or downstream interpretation requires a new version. Old versions are marked `deprecated` with a `sunset_at`; after sunset, ingestion rejects them with `schema_version_sunset`.

### Forbidden-field policy

Two-tier code-backed policy in `catalog/policy/forbidden-fields.ts`. Default is **default-capture, narrow-reject**: only named-field `pii_card` and `pii_secret` rules block capture. Pattern-based detections (PAN-in-unexpected-field, AWS key shape, GitHub token shape, JWT shape, generic high-entropy) redact-with-metric — they replace the value and continue the event, emitting `polaris_ingest_redacted_pattern_total` so leaks are observable without dropping events on regex false positives.

Reject list: event rejected with `forbidden_field_rejected`. Redact list: field value replaced with `"[REDACTED:<reason>]"` and the event continues. Reason codes are a closed set: `pii_card`, `pii_account`, `pii_secret`, `policy`, `length`, `pattern_match`. Project overrides may not downgrade platform rejects without a documented exception.

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
- validate envelopes and properties against the declared `schema_version`
- enforce the two-tier forbidden-field policy (reject vs redact, from `catalog/policy/forbidden-fields.ts`) before any logging
- perform 15-minute event ID dedupe as a retry-storm absorber (per-project override up to 24h is opt-in)
- emit reason codes `unsupported_schema_version` and `schema_version_sunset` when applicable
- publish valid events to RabbitMQ
- return per-event batch results

It should not:

- enrich
- resolve identity
- attribute
- call vendors
- aggregate analytics
- treat ingress dedupe as the canonical idempotency layer (downstream consumers must remain idempotent)

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

Destination consumers run a three-stage pipeline:

1. **Normalize** — hash PII, lowercase/trim, format timestamps, currency units, map consent signals into vendor slots. Pure, stateless, no network. Composes from `packages/shared-destination-normalize/` plus consumer-specific rules.
2. **Map** — pure function from normalized intermediate to vendor payload. One mapper per (canonical event, consumer version). Mappers cannot read raw canonical PII; they only see the normalized intermediate.
3. **Deliver** — the only stage that talks to the network. Owns auth, batching, rate limits, retries, DLQs, idempotency, vendor dedupe fields, delivery records.

Each stage is independently versioned so a hashing-rule fix does not force a v2 of every mapper.

Mappings are code-only. PostgreSQL may store destination instances and operational knobs, but not event-to-vendor mapping semantics.

Consumers must implement:

- normalization (composing from the shared package plus vendor-specific rules)
- mapping per canonical event
- delivery with batching, retries, DLQs, rate limits, delivery records, idempotency, vendor dedupe fields where supported

Destination sends during replay are disabled by default.

## ClickHouse

Do not query ingestion interface tables directly.

Use:

```text
ingestion interface table
  -> analytics_ingest_log
  -> analytics_raw
  -> materialized views
  -> projection tables
```

`analytics_ingest_log` is append-only. `analytics_raw` is the deduped analytical fact table.

`analytics_raw` is never queried without explicit dedupe. MVs feeding projection tables use `argMax(col, _version)` per `(project_id, environment, event, event_id)`. Projection tables store already-deduped rows and are the read surface for dashboards.

### Access model

Services and CLI code never import `@clickhouse/client` directly. Always go through `packages/shared-clickhouse/`. The helper exposes two profiles:

- `service` profile authenticates as `polaris_service` (SELECT on projection tables and `analytics_ingest_log` only). Used by ingester, processors, consumers, future dashboard API, and CLI inspection commands.
- `operator` profile authenticates as `polaris_operator` (broader access including `analytics_raw`). Used by replay/rebuild jobs and operator-issued investigation commands.

`analytics_raw` reads go through the helper's `replay.argMaxByEventKey(...)` and `replay.countDistinctEvents(...)` methods, which generate the correct `argMax` SQL. `operator.raw.query(sql, params)` is the escape hatch and emits a metric on every call.

`FINAL` is not the default. The escape hatch is the only place it appears, and only by the caller's deliberate choice.

### Engine families

Production uses `Replicated*` engines and ClickHouse Keeper from day one, even on a single replica. Local/dev uses plain `MergeTree`/`ReplacingMergeTree` without Keeper. DDL is parameterized through a `{replicated}` macro so the same SQL works in both modes.

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
