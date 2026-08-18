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

## Regional Posture

Polaris is **single-region** in v1. One RabbitMQ cluster, one ClickHouse cluster, one PostgreSQL primary, one Redis. Multi-region (active-active, active-passive, regional sharding) is not in scope until a concrete project requires it.

PII residency is **not a v1 constraint**. Polaris does not promise per-region storage of personal data; projects with data-residency obligations are not in v1's target use cases. If a future project requires residency, the design pattern is per-project topic isolation routed to a regionally-deployed Polaris instance, not in-cluster sharding.

## Secret Management

Per-project secrets are stored in the control-plane database as plaintext. There is no external secret provider and no resolution step.

Rules:

- `destinations.secret_value` holds a vendor credential; `project_config.value` with `is_secret = true` holds a project's own sensitive values.
- App and deployment credentials stay in the process environment, read at bootstrap.
- Secret values must never appear in logs, audit records, DLQs, delivery records, or exports. Masking at the data layer and `Secret<T>` boxing at the point of use are what enforce this — see [Control Plane — Secrets](02-control-plane.md).
- The control-plane database is therefore credential material. Its access controls, backups and replicas carry the same sensitivity as the credentials themselves, and this is the single largest security consequence of the design.
- Argon2id hashes (`api_keys.hash`, `operator_tokens.hash`) remain one-way and are not affected.

## Control-Plane Permissions

v1 uses a minimal trusted-operator model. One property per command, one rule.

Rules:

- Operator identity sources are `operator_token`, `declared`, `cli`, `migration`, and `system`. See [Control Plane / Operator Identity and Audit Actor](./02-control-plane.md) for the full definitions, including why `declared` means the opposite of what an earlier draft of this design intended.
- `operator_token` is the CLI's authenticated source and `declared` the control-plane API's; `cli` is the unauthenticated fallback and cannot clear the production gate. Personal operator tokens are scoped per environment and stored as argon2id hashes in PostgreSQL.
- Each CLI command carries a `mutates: boolean` property. The dispatcher rejects any command where `mutates && environment === 'production' && actorSource === 'declared'`. Everything else is allowed.
- Mutating commands in non-production environments bypass the gate (dev and staging stay friction-free).
- Every mutating CLI command writes one audit record. Gate denials land on the same record (`result = denied`, `denied_reason` set).
- `--actor` survives only as a display label. It cannot upgrade a `declared` source.
- Token rotation issues a new token and immediately revokes the old one. No grace period.
- RBAC is deferred. A dedicated IdP-backed CLI source is a P11+ stretch goal; today an IdP-authenticated admin session reaches the audit trail as `declared`.

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

RabbitMQ:

```text
raw.events              90 days
identified.events        7 days   (regenerable by replaying identity)
resolved.events         30 days
profile.events          30 days
identity.events         30 days
session.events          30 days
attribution.events      30 days
rejected.events          7 days   (a week-old governance signal is a dashboard entry)
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

Object-storage raw archive is a future extension. Until it exists, RabbitMQ `raw.events` retention defines the practical raw replay window. The replayability principle is bounded by this window — Polaris does not promise replay beyond the operational retention window in v1.

## RabbitMQ Production Defaults

RabbitMQ sizing is configurable per environment. Start with boring high-availability defaults in production.

Production:

```text
brokers                         3
replication_factor              3
min_in_sync_replicas            2
raw.events partitions           24
identified.events partitions    24
resolved.events partitions      24
profile.events partitions       12
identity.events partitions      12
session.events partitions       12
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
ingestion interface table     transient ingestion interface
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

- The ingestion interface table is never queried directly.
- Persist ingested rows before querying.
- `analytics_raw` is never queried without explicit dedupe (`argMax(_version)` aggregation, `SETTINGS final = 1`, or `count(DISTINCT event_id)` shape).
- MVs use `argMax` to feed deduped rows into projection tables.
- Projection tables are the read surface for dashboards; they use plain `SELECT`.
- `FINAL` in production dashboards is the exception, not the default.
- See [ClickHouse](./07-clickhouse.md) for the full query pattern reference.

### Cluster posture

- Single-node ClickHouse is acceptable for local/dev and first vertical slice.
- Production starts single-shard, single-replica, with `Replicated*` engines and Keeper. Adding replicas is straightforward.
- `Distributed` tables and multi-shard layouts are not v1. Sharding is honest future work, not a backwards-compatible engine swap.

## Backup and Recovery

Recovery objectives per store. Numbers are v1 defaults; production tuning may tighten them.

| Store | Holds | RPO | RTO | Strategy |
|---|---|---|---|---|
| PostgreSQL | audit, replay jobs, processor runs, destination instances, operator tokens, API key hashes, schema/source registry, topic isolations | 5 min | 1 h | daily snapshot + continuous WAL streaming; 7-day point-in-time recovery |
| ClickHouse `analytics_raw` | deduped analytical facts | 24 h | 4 h (recent partitions) | daily `BACKUP TABLE` to object storage |
| ClickHouse projection tables | derived from `analytics_raw` via MVs | N/A | per-projection rebuild time, documented at projection creation | no backup; rebuild from `analytics_raw` |
| ClickHouse `analytics_ingest_log` | append-only landing log, 30-day TTL | 7 d | 4 h | weekly snapshot, monthly cold archive |
| RabbitMQ | canonical event topics | 0 under normal operation (RF=3, min-ISR=2) | <1 h broker replacement | in-cluster RF; tiered storage future work |
| Redis | dedupe windows, rate limits, processor caches | N/A | N/A | no backup; loss = transient duplicate increase, downstream handles |
| Secret provider | references (no plaintext) | provider-managed | provider-managed | out of scope for Polaris backups |

Rules:

- The backup strategy lives in code and infrastructure templates, not runbook prose.
- Restore validation is exercised in staging at least quarterly.
- Audit records and operator tokens are the most operationally sensitive Postgres rows; losing them creates compliance gaps. The 5-minute RPO targets this.
- ClickHouse projection rebuilds run through the standard replay/rebuild workflow ([P7-005](../../agents/pm/kanban/done/P7-005-clickhouse-rebuild-workflows.md)), not as ad-hoc SQL.
- Secret provider backups are the provider's responsibility; Polaris stores only references.

## Open Production Decisions

These are wait-for-data items. Each has a structural decision locked and a numeric/inventory tail that gets revisited after observed production traffic. Re-review after the first project's first production month.

- **RabbitMQ retention byte caps and tiered storage.** Time-based retention is locked (90 days for `raw.events`). Byte caps as a backstop and tiered storage offload are evaluated when first-project disk usage data exists.
- **Per-project ingress dedupe window overrides.** Default 15 min is locked. Per-project opt-ins up to 24h are evaluated when a project demonstrates a producer-side reliability need.
- **Topic isolation activation thresholds.** Triggers are locked structurally (volume share, retention divergence, lag isolation, schema risk, operational quarantine — see [RabbitMQ Streams](./03-rabbitmq-streams.md)). The `>25%` threshold and similar numbers are revisited after observed traffic.
- **Alert thresholds and SLOs.** Initial defaults are locked in [P10-005](../../agents/pm/kanban/done/P10-005-alerts-and-incident-runbooks.md); tightened after observed traffic.

## Methodology Decisions (No Single Lock)

These are not single decisions — they are processes that produce decisions per artifact.

- **ClickHouse projection table engines:** chosen per projection in the PR that ships it. See [ClickHouse / Engine Selection Methodology](./07-clickhouse.md).
- **Event catalog inventory:** the platform does not pre-define business events. Projects bring their own event lists; the platform ships only processor-output events (identity, sessionizer, attribution, diagnostics) defined in their respective processor tasks.
- **Per-vendor mapping specifications and normalization rules:** decided per consumer task (P9-003 Meta CAPI, P9-004 GA4, etc.) as part of each task's acceptance criteria.

## Locked Decisions That Previously Sat Here

- Production secret manager: **none.** Vault was implemented (P11-004) and then removed: per-project secrets moved into the control-plane database as plaintext, which were its only callers. See [Control Plane — Secrets](02-control-plane.md) for what that trades away.
- ClickHouse cluster shape: single-shard single-replica with `Replicated*` engines + Keeper from day one. Multi-shard is honest future work.
- Identity graph schema: file-flexible (see [P8-002](../../agents/pm/kanban/done/P8-002-identity-resolver-v1.md)).
- Regional posture: single-region in v1; PII residency not a v1 constraint.
- OIDC IdP for a dedicated CLI actor source: Keycloak when implemented (P11+ stretch).
- GeoIP backend: MaxMind GeoLite2 with operator-provided files.
- CLI access model: thin client + control-plane API service, env-var auth.
