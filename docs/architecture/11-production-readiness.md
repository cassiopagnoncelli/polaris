# Production Readiness

This document records production-facing defaults and open decisions for Polaris. It should stay practical: enough to guide implementation without pretending every production detail is known before the first real deployment.

## Deployment Model

Polaris services are containerized.

Environment targets:

```text
production       Docker images on Kubernetes
staging/test     Docker-based environments
development      Docker or bare metal
```

Rules:

- Docker images are the common deployable artifact.
- Production runs on Kubernetes.
- Staging/test may use Docker Compose or another Docker-based runner.
- Development may use Docker Compose or bare metal services.
- Services must not assume Kubernetes-only runtime behavior.
- Runtime configuration comes from environment variables validated by shared config.
- Secrets are references, not plaintext config.

## Secret Management

Polaris uses provider-based secret references.

Production secret storage is not fully locked yet. Vault is the preferred candidate direction unless implementation-time constraints point elsewhere.

Rules:

- PostgreSQL stores `secret_provider` and `secret_ref`, not secret values.
- Local/dev can use the `env` provider.
- Production should use an external secret provider.
- The provider interface must be compatible with Vault-style secret lookup.
- Secret values must never appear in logs, audit records, DLQs, delivery records, or exports.

## Control-Plane Permissions

v1 uses a minimal trusted-operator model. One property per command, one rule.

Rules:

- Operator identity sources are `cli_oidc`, `cli_token`, and `declared`. See [Control Plane / Operator Identity and Audit Actor](./02-control-plane.md) for the full definitions.
- `cli_token` is the only authenticated source in v1. Personal operator tokens are scoped per environment and stored as hashes in PostgreSQL.
- Each CLI command carries a `mutates: boolean` property. The dispatcher rejects any command where `mutates && environment === 'production' && actorSource === 'declared'`. Everything else is allowed.
- Mutating commands in non-production environments bypass the gate (dev and staging stay friction-free).
- Every mutating CLI command writes one audit record. Gate denials land on the same record (`result = denied`, `denied_reason` set).
- `--actor` survives only as a display label. It cannot upgrade a `declared` source.
- Token rotation issues a new token and immediately revokes the old one. No grace period.
- RBAC is deferred. `cli_oidc` is a P11+ stretch goal.

Future RBAC should not require rewriting the control-plane data model.

## Replay Mechanics Draft

Replay is controlled by durable replay jobs in PostgreSQL.

Initial functional model:

- every replay starts as a dry run
- every executable replay references a prior plan
- replay jobs are scoped by `project_id`, `environment`, source topic, and time window or offset range
- replay jobs target an exact processor or consumer version
- replay execution uses a unique consumer group, for example `polaris-replay-<job_id>`
- replay output includes replay metadata and lineage
- destination sends are disabled by default
- destination sends during replay require explicit opt-in

Initial output policy:

```text
dry_run            no output events
shadow_topic       write to replay/shadow topic for inspection
canonical_topic    write to canonical output topic only with explicit approval
```

The default executable mode should be `shadow_topic`. `canonical_topic` is a higher-risk mode and must be explicit.

Archive-backed replay is a future extension once object-storage raw archive exists.

## SDK Release and Hosting

The Web SDK ships as:

```text
ESM npm package
script-tag browser bundle
async loader snippet
```

Sensible defaults:

- package versions use semver
- browser bundles are versioned immutably
- versioned CDN paths use long cache lifetimes
- `latest` aliases are allowed only for development or explicitly non-production usage
- production snippets should pin an exact SDK version
- global browser object defaults to `Polaris`
- CDN base URL is configurable
- SRI hashes should be generated for published browser bundles where practical
- CSP guidance should be documented for script-tag installs

Example path shape:

```text
/web-sdk/v1.2.3/polaris.min.js
/web-sdk/v1.2.3/polaris-loader.min.js
```

## Data Lifecycle Defaults

All lifecycle values are configurable. These defaults are a starting point for v1.

Redpanda:

```text
raw.events              90 days
identity.events         30 days
enriched.events         30 days
attribution.events      30 days
analytics.events        30 days
retry topics             7 days
dlq topics              retain unresolved; 30 days after resolution
```

ClickHouse:

```text
analytics_ingest_log    30 days
analytics_raw          400 days
projection tables        per table, default 400 days
operational metrics     180 days unless exported elsewhere
```

PostgreSQL:

```text
api key metadata         active lifetime + 2 years after revoke
audit records            2 years
replay jobs              2 years
processor runs           1 year
delivery records         180 days
resolved DLQ metadata    180 days
```

Redis:

```text
ingress dedupe           15 minutes default; up to 24 hours per project on opt-in
rate-limit counters      short TTL by window
processor ephemeral state processor-specific TTL
```

SDK local queues:

```text
web queued events        bounded by count/bytes; max age configurable
node memory queue        process lifetime only unless durable adapter is configured
```

Object-storage raw archive is a future extension. Until it exists, Redpanda `raw.events` retention defines the practical raw replay window. The replayability principle is bounded by this window — Polaris does not promise replay beyond the operational retention window in v1.

## Redpanda Production Defaults

Redpanda sizing is configurable per environment. Start with boring high-availability defaults in production.

Production:

```text
brokers                         3
replication_factor              3
min_in_sync_replicas            2
raw.events partitions           24
analytics.events partitions     24
identity.events partitions      12
enriched.events partitions      12
attribution.events partitions   12
retry topic partitions           6
dlq topic partitions             6
```

Local/development:

```text
brokers                         1
replication_factor              1
topic partitions                 1-3
```

Staging/test:

```text
brokers                         1 for cheap test environments
brokers                         3 for production-like pre-prod
replication_factor              1 or 3 depending on environment purpose
```

Rules:

- Topic partition counts are defaults, not permanent constants.
- Increase partitions when throughput or consumer parallelism requires it.
- Avoid decreasing partition counts as a normal operation.
- Use time-based retention first.
- Add retention byte caps after observing real event volume.
- Tiered storage/object archive remains future work for long-term raw replay.

## ClickHouse Physical Defaults

ClickHouse starts with a simple, SQL-native physical model:

```text
Kafka Engine table     transient ingestion interface
analytics_ingest_log   MergeTree / ReplicatedMergeTree append-only log
analytics_raw          ReplacingMergeTree / ReplicatedReplacingMergeTree deduped analytical facts
projection tables      MergeTree / SummingMergeTree / AggregatingMergeTree depending on purpose
```

Defaults:

```text
analytics_ingest_log partitioning    toYYYYMM(ingested_at)
analytics_ingest_log ordering        project_id, environment, ingested_at, event_id
analytics_ingest_log TTL             30 days
analytics_raw partitioning           toYYYYMM(occurred_at)
analytics_raw ordering               project_id, environment, event, event_id
analytics_raw TTL                    400 days
```

### Engine families per environment

```text
local/dev      plain MergeTree, ReplacingMergeTree     no Keeper
production     Replicated* engines from day one        Keeper required
```

DDL is parameterized through a `{replicated}` macro so the same SQL file works in both. Production runs ClickHouse Keeper alongside ClickHouse from day one; embedded Keeper is acceptable for the first single-replica production deployment, external Keeper becomes necessary when multiple replicas land.

### Query patterns

- Kafka Engine tables are never queried directly.
- Persist Kafka Engine rows before querying.
- `analytics_raw` is never queried without explicit dedupe (`argMax(_version)` aggregation, `SETTINGS final = 1`, or `count(DISTINCT event_id)` shape).
- MVs use `argMax` to feed deduped rows into projection tables.
- Projection tables are the read surface for dashboards; they use plain `SELECT`.
- `FINAL` in production dashboards is the exception, not the default.
- See [ClickHouse](./07-clickhouse.md) for the full query pattern reference.

### Cluster posture

- Single-node ClickHouse is acceptable for local/dev and first vertical slice.
- Production starts single-shard, single-replica, with `Replicated*` engines and Keeper. Adding replicas is straightforward.
- `Distributed` tables and multi-shard layouts are not v1. Sharding is honest future work, not a backwards-compatible engine swap.

## Open Production Decisions

These are intentionally not fully locked yet:

- exact production secret manager
- Redpanda retention byte caps and tiered storage
- ClickHouse projection table engines per query shape
- ClickHouse multi-shard layout (single-shard is v1)
- first real event catalog inventory
- destination-specific mapping specifications and normalization rules per vendor
- identity graph schema and conflict policy
- production alert thresholds and SLOs
- per-project ingress dedupe window overrides
- topic isolation activation thresholds tuned to observed traffic
- OIDC integration for `cli_oidc` operator identity

These should be decided before real production traffic, but they do not block the first vertical slice.
