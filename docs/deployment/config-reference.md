# Polaris Configuration Reference

Per-service inventory of runtime environment variables, separated into
required vs optional. The variable definitions and validation rules
live in the Zod schemas at
[`libs/runtime/config/src/schemas/`](../../libs/runtime/config/src/schemas/);
this page is operator-facing and reproduces the inventory for quick
scanning. If the two ever drift, the schemas win and this page is fixed
in the same PR.

The shared blocks below are composed per service. A service's runtime
config is "shared blocks it composes" + "its own block". The
[`.env.example`](../../.env.example) file at the repo root is the single
template that covers every variable below — copy and trim to the
service you are deploying.

> **Convention.** Variables marked **required** throw at startup if
> missing. Variables marked **optional** carry a default in the Zod
> schema. Secret-bearing variables are listed with an `OBTAIN FROM`
> note in `.env.example`; never commit a real value.

## Shared blocks

These compose into every service.

### service (shared)

[`libs/runtime/config/src/schemas/service.ts`](../../libs/runtime/config/src/schemas/service.ts)

| Variable | Status | Notes |
| --- | --- | --- |
| `POLARIS_SERVICE_NAME` | required | Identifier on logs / `/health` / metrics labels. |
| `POLARIS_ENV` | required | `local` / `development` / `staging` / `production`. |
| `POLARIS_SERVICE_VERSION` | optional | Defaults to `0.0.0`; set by Docker build args. |
| `POLARIS_LOG_LEVEL` | optional | Pino level; defaults to `info`. |
| `POLARIS_LOG_PRETTY` | optional | Bool; defaults to true only when `POLARIS_ENV=local`. |
| `POLARIS_GIT_SHA` | optional | Stamped by Docker build. |
| `POLARIS_BUILD_TIME` | optional | Stamped by Docker build. |

### http (shared, Fastify-backed services)

[`libs/runtime/config/src/schemas/http.ts`](../../libs/runtime/config/src/schemas/http.ts)

| Variable | Status | Notes |
| --- | --- | --- |
| `POLARIS_HTTP_HOST` | optional | Defaults to `0.0.0.0`. |
| `POLARIS_HTTP_PORT` | optional | Defaults to `3000`; per-service Dockerfile pins a canonical port (see [`infra/docker/README.md`](../../infra/docker/README.md)). |
| `POLARIS_HTTP_BODY_LIMIT_BYTES` | optional | Defaults to 1 MiB (`1048576`). |
| `POLARIS_HTTP_REQUEST_TIMEOUT_MS` | optional | Defaults to `15000`. |
| `POLARIS_HTTP_KEEPALIVE_TIMEOUT_MS` | optional | Defaults to `5000`. |

### postgres (shared, any service that hits PostgreSQL)

[`libs/runtime/config/src/schemas/postgres.ts`](../../libs/runtime/config/src/schemas/postgres.ts)

| Variable | Status | Notes |
| --- | --- | --- |
| `POLARIS_POSTGRES_HOST` | required | |
| `POLARIS_POSTGRES_DATABASE` | required | |
| `POLARIS_POSTGRES_USER` | required | |
| `POLARIS_POSTGRES_PASSWORD` | required (secret) | OBTAIN FROM secret provider. |
| `POLARIS_POSTGRES_PORT` | optional | Defaults to `5432`. |
| `POLARIS_POSTGRES_SSL` | optional | Defaults to false; set true in production. |
| `POLARIS_POSTGRES_POOL_MAX` | optional | Defaults to `10`. |
| `POLARIS_POSTGRES_CONNECT_TIMEOUT_MS` | optional | Defaults to `10000`. |
| `POLARIS_POSTGRES_IDLE_TIMEOUT_MS` | optional | Defaults to `30000`. |

### redis (shared, ingester today)

[`libs/runtime/config/src/schemas/redis.ts`](../../libs/runtime/config/src/schemas/redis.ts)

| Variable | Status | Notes |
| --- | --- | --- |
| `POLARIS_REDIS_HOST` | required | |
| `POLARIS_REDIS_PORT` | optional | Defaults to `6379`. |
| `POLARIS_REDIS_DB` | optional | `0..15`; defaults to `0`. |
| `POLARIS_REDIS_USERNAME` | optional | |
| `POLARIS_REDIS_PASSWORD` | optional (secret) | OBTAIN FROM secret provider. |
| `POLARIS_REDIS_CONNECT_TIMEOUT_MS` | optional | Defaults to `5000`. |
| `POLARIS_REDIS_KEY_PREFIX` | optional | |

### rabbitmq (shared, any service that produces or consumes events)

[`libs/runtime/config/src/schemas/rabbitmq.ts`](../../libs/runtime/config/src/schemas/rabbitmq.ts)

| Variable | Status | Notes |
| --- | --- | --- |
| `POLARIS_RABBITMQ_URL` | required (secret) | `amqp(s)://user:pass@host:port/vhost`. OBTAIN FROM secret provider. Rejected at load if TLS is on and the scheme is plaintext `amqp://`. |
| `POLARIS_RABBITMQ_MANAGEMENT_URL` | optional | HTTP management API. Provisioning and operator tooling only, never the data path. |
| `POLARIS_RABBITMQ_CLIENT_ID` | required | Connection name shown in the management UI. Set it to the service name so broker-side connection lists are attributable. |
| `POLARIS_RABBITMQ_TLS` | optional | Defaults to false; set true in production. |
| `POLARIS_RABBITMQ_HEARTBEAT_SECONDS` | optional | Defaults to `30`. |
| `POLARIS_RABBITMQ_CONNECTION_TIMEOUT_MS` | optional | Defaults to `10000`. |
| `POLARIS_RABBITMQ_PARTITIONS` | optional | Default super-stream width. Defaults to `3`. **Changing it is a migration, not a restart** — the publisher hashes the partition key modulo this value, so two instances disagreeing breaks per-identity ordering. See [runbook-rabbitmq-topology.md](../operations/runbook-rabbitmq-topology.md). |
| `POLARIS_RABBITMQ_PARTITION_OVERRIDES` | optional | Per-family widths, `raw.events=6,resolved.events=3`. Same migration rule as above. |
| `POLARIS_RABBITMQ_ASSIGNED_PARTITIONS` | optional | Static partition assignment for THIS instance, e.g. `0,1`. Empty means "own every partition". RabbitMQ has no consumer-group rebalancing, so scaling out means giving each replica a disjoint slice — a partition nobody is assigned is a silent backlog. |
| `POLARIS_RABBITMQ_PREFETCH` | optional | Per-partition QoS window. Defaults to `100`. Controls how far the broker runs ahead, NOT handler concurrency — handlers stay serial per partition so per-identity ordering holds. |
| `POLARIS_RABBITMQ_CHECKPOINT_EVERY` | optional | Messages between checkpoint writes. Defaults to `500`. |
| `POLARIS_RABBITMQ_CHECKPOINT_INTERVAL_MS` | optional | Time between checkpoint writes. Defaults to `5000`. Larger values mean fewer Postgres writes and more redelivery after a crash. |
| `POLARIS_RABBITMQ_STREAM_RETENTION_DAYS` | optional | Applied as `x-max-age` at declaration time, so it affects only streams that do not exist yet. Defaults to `90`. |

> Every service that consumes also needs the `postgres` block: stream
> consumers own their resume point in `transport_checkpoints` because
> AMQP has no server-side offset store.

### clickhouse (shared, operator/CLI; future analytics services)

[`libs/runtime/config/src/schemas/clickhouse.ts`](../../libs/runtime/config/src/schemas/clickhouse.ts)

| Variable | Status | Notes |
| --- | --- | --- |
| `POLARIS_CLICKHOUSE_URL` | required | `http://` or `https://`. |
| `POLARIS_CLICKHOUSE_DATABASE` | required | |
| `POLARIS_CLICKHOUSE_SERVICE_USER` | required | SELECT-only role. |
| `POLARIS_CLICKHOUSE_SERVICE_PASSWORD` | required (secret) | OBTAIN FROM secret provider. |
| `POLARIS_CLICKHOUSE_OPERATOR_USER` | optional | Set as a pair with PASSWORD; required for operator commands. |
| `POLARIS_CLICKHOUSE_OPERATOR_PASSWORD` | conditional (secret) | OBTAIN FROM secret provider. |
| `POLARIS_CLICKHOUSE_REQUEST_TIMEOUT_MS` | optional | Defaults to `30000`. |
| `POLARIS_CLICKHOUSE_MAX_OPEN_CONNECTIONS` | optional | Defaults to `10`. |

## Services

### ingester-api

Source: [`apps/ingester-api/src/config.ts`](../../apps/ingester-api/src/config.ts).

Composes: **service + http + postgres + rabbitmq + redis** plus the local
blocks below.

#### authCache

| Variable | Status | Default |
| --- | --- | --- |
| `POLARIS_AUTH_CACHE_MAX_ENTRIES` | optional | `1024` |
| `POLARIS_AUTH_CACHE_TTL_MS` | optional | `60000` |
| `POLARIS_AUTH_CACHE_NEGATIVE_TTL_MS` | optional | `5000` |

#### ingest

| Variable | Status | Default |
| --- | --- | --- |
| `POLARIS_INGEST_DEDUPE_DEFAULT_WINDOW_SEC` | optional | `900` (15 min) |
| `POLARIS_INGEST_DEDUPE_MAX_WINDOW_SEC` | optional | `86400` (24 h) |
| `POLARIS_INGEST_REDIS_KEY_PREFIX` | optional | `polaris:ingest:dedupe` |
| `POLARIS_INGEST_REDIS_OP_TIMEOUT_MS` | optional | `50` |
| `POLARIS_INGEST_MAX_BATCH_EVENTS` | optional | `1000` |
| `POLARIS_INGEST_STAMP_CLIENT_CONTEXT` | optional | `true` |
| `POLARIS_INGEST_FORWARDED_TRUST_DEPTH` | optional | `0` (the socket peer) |

#### Client context: the address and the user agent

A browser cannot know its own public address, so for **browser- and
mobile-typed API keys** the ingester fills `context.ip` and
`context.user_agent` from the connection when the producer sent `null`. A
producer-sent value is always kept, which is what leaves a first-party relay
(which stamped the address itself) untouched. Backend, server and internal
keys are never stamped: a server's own address is noise.

`POLARIS_INGEST_FORWARDED_TRUST_DEPTH` is how many trusted proxies sit in
front of the ingester, and it must match the deployment:

| Depth | Where the address comes from | Use it when |
| --- | --- | --- |
| `0` (default) | the socket peer; `X-Forwarded-For` is not read at all | nothing terminates in front of the ingester, or the front end is one you do not control |
| `1` | the right-most `X-Forwarded-For` entry | exactly one trusted reverse proxy / load balancer |
| `n` | the n-th `X-Forwarded-For` entry from the right | n trusted hops, all of which append |

The chain is counted from the **right** because each proxy appends the
address it accepted the connection from. A client that sends its own
`X-Forwarded-For` only lengthens the untrusted prefix, so a spoofed hop
cannot move the selection. Set the depth **too high** and nothing is
stamped at all (a chain shorter than the depth selects nothing, on purpose);
set it **too low** and you stamp your own proxy's address.

Only `X-Forwarded-For` is honoured. `X-Real-IP` carries one address and no
hop count, so no trust depth can be expressed against it; `Forwarded`
(RFC 7239) is a list but its `for=` values may be quoted, port-suffixed or
obfuscated, and nothing says which header wins when the two disagree. A
front end that speaks only `X-Real-IP` should run at depth `0`.

Two things turn collection off:

- `POLARIS_INGEST_STAMP_CLIENT_CONTEXT=false` — per environment, for
  operators who must not collect addresses there. It does **not** disable
  the opt-out below, which only ever removes data.
- A producer sending `context.ip: "0.0.0.0"` — Segment's convention for "do
  not collect". Honoured on every key type, and normalised to `null` so the
  sentinel never reaches the store.

Watch the rollout on `polaris_ingest_client_context_total`
(`field` = `ip` / `user_agent`, `outcome` = `stamped`, `producer`,
`opted_out`, `unavailable`, `disabled`) — the "Client context stamping"
panel on the Polaris — Ingestion dashboard. A rising `unavailable` is the
signal that the trust depth does not match the deployment.

#### Removed: the per-project override strings

`POLARIS_INGEST_PROJECT_DEDUPE_WINDOWS` and `POLARIS_RATE_LIMIT_PROJECT_OVERRIDES`
are gone. They were comma-separated `project_id=value` strings parsed by hand,
which meant adding a project was a global env-var edit and a redeploy, with no
validation, no audit and no per-key history.

Both moved into `project_config` under the `ingest` namespace
(`dedupe_window_sec`, `rate_limit_rps`), set with `polaris config set` or the
admin UI's Variables panel and picked up by running replicas without a restart.
The remaining `POLARIS_INGEST_DEDUPE_*` and `POLARIS_RATE_LIMIT_*` variables are
unchanged: they are the fleet-wide defaults a project's value overrides.

If you have an environment that still sets either string, `node
scripts/backfill-project-config.mjs --service ingester-api --env <env>` reads
them from that environment and seeds the equivalent rows. Nothing reads them at
runtime any more, so an unmigrated value is silently the deployment default.

#### rateLimit

| Variable | Status | Default |
| --- | --- | --- |
| `POLARIS_RATE_LIMIT_PER_API_KEY_RPS` | optional | `1000` (0 disables, fail-open) |
| `POLARIS_RATE_LIMIT_WINDOW_SECONDS` | optional | `1` |
| `POLARIS_RATE_LIMIT_REDIS_KEY_PREFIX` | optional | `polaris:ingest:rl` |
| `POLARIS_RATE_LIMIT_REDIS_OP_TIMEOUT_MS` | optional | `50` |

### control-plane-api

Source: [`apps/control-plane-api/src/config.ts`](../../apps/control-plane-api/src/config.ts).

Composes: **service + http + postgres**. No RabbitMQ or Redis in v1.

### processors

All processors compose **service + http + rabbitmq** plus their own block.
The spine stages are the ones that also compose **postgres** today.

#### sync-identity-resolver v1

Source: [`sync/identity/resolver/v1/src/config.ts`](../../sync/identity/resolver/v1/src/config.ts).

Also composes **postgres**: it is the profile store's only writer.

#### sync-enrichment-runtime v1

Source: [`sync/enrichment/runtime/v1/src/config.ts`](../../sync/enrichment/runtime/v1/src/config.ts).

Reads the profile store; never writes it.

| Variable | Status | Default |
| --- | --- | --- |
| `POLARIS_SYNC_ENRICHMENT_CONSUMER_GROUP` | optional | `polaris-sync-enrichment-v1` |
| `POLARIS_SYNC_ENRICHMENT_CATALOG_ROOT` | optional | `.` |
| `POLARIS_SYNC_ENRICHMENT_GEOIP_DB_PATH` | optional | unset |

`GEOIP_DB_PATH` names the MaxMind `.mmdb` **as the container sees it**,
conventionally `/etc/polaris/geoip/GeoLite2-City.mmdb`. The file is
license-restricted and never baked into the image; mount the directory
read-only and fetch into it with
[`infra/geoip/refresh-geoip.sh`](../../infra/geoip/refresh-geoip.sh) —
see [`infra/docker/README.md`](../../infra/docker/README.md) "Mounted
data" for the volume shape and the [refresh
runbook](../operations/runbook-geoip-refresh.md) for the cadence.

Leaving it unset, or setting it at a path nothing is mounted on, is a
**supported posture and not a misconfiguration**: the stage logs one
warning naming the path it tried, runs fail-open, and stamps
`geo.source: "no_lookup"` on every event rather than refusing to start.
Geo is decoration on the spine and every destination sits behind this
stage. `polaris_enrichment_geoip_database_loaded` reports which of the
two states a process is in, whether or not any traffic is flowing.

The stage reads the file once at boot and holds that snapshot for the
life of the process, so a refresh reaches a running deployment only on
restart — which is what keeps the `source` stamped on its events an
honest answer to "which database produced this row".

#### sessionizer v1

Source: [`async/computation/sessionizer/v1/src/config.ts`](../../async/computation/sessionizer/v1/src/config.ts).

| Variable | Status | Default |
| --- | --- | --- |
| `POLARIS_SESSIONIZER_CONSUMER_GROUP` | optional | `polaris-sessionizer-v1` |
| `POLARIS_SESSIONIZER_CONCURRENCY` | optional | `1` |
| `POLARIS_SESSIONIZER_INACTIVITY_SECONDS` | optional (semantic) | `1800` |

`INACTIVITY_SECONDS` is **semantic**: the runtime accepts the env var
only to mirror the manifest default; changing the value requires a v2
processor directory + manifest, not a deployment override.

#### attribution-engine v3

Source: [`async/computation/attribution-engine/v3/src/config.ts`](../../async/computation/attribution-engine/v3/src/config.ts).
v1 and v2 were deleted with the fan-out; the defaults below are kept as the
history of what those versions used, because a `processor_activations` row
naming one is still readable and the column values have to mean something.

| Variable | Status | Default (v1) | Default (v2) |
| --- | --- | --- | --- |
| `POLARIS_ATTRIBUTION_ENGINE_CONSUMER_GROUP` | optional | `polaris-attribution-engine-v1` | `polaris-attribution-engine-v2` |
| `POLARIS_ATTRIBUTION_ENGINE_CONCURRENCY` | optional | `1` | `1` |

v2 adds a 90-day attribution window (v1 has none). The window itself has
**no environment variable**: it is a semantic rule, so it lives in the v2
manifest and changing it requires a v3. Both versions may be enabled at once
during a cutover — their touchpoint chains are isolated by `processor_version`
in `attribution_touchpoint_chains`, and the differing consumer-group defaults
keep their stream offsets separate.

### jobs

#### geoip refresh

Source: [`infra/geoip/refresh-geoip.sh`](../../infra/geoip/refresh-geoip.sh).

Not a service: a cron job on the host that owns the volume mounted at
`POLARIS_SYNC_ENRICHMENT_GEOIP_DB_PATH` above. It composes none of the
shared blocks — these four variables are its whole interface.

| Variable | Status | Default |
| --- | --- | --- |
| `POLARIS_GEOIP_LICENSE_KEY` | **required** | — |
| `POLARIS_GEOIP_DB_PATH` | **required** | — |
| `POLARIS_GEOIP_EDITION` | optional | `GeoLite2-City` |
| `POLARIS_GEOIP_KEEP_PREVIOUS` | optional | `1` |

`POLARIS_GEOIP_DB_PATH` is the path the job **writes on the host**;
`POLARIS_SYNC_ENRICHMENT_GEOIP_DB_PATH` is the path the stage **reads in
the container**. They coincide only when both run on the same
filesystem — which they do locally, where `make geoip-refresh` defaults
the first to `resources/maxmind/GeoLite2-City.mmdb` and the enrichment
stage's `dev` script defaults the second to the same file.

### consumers (destinations)

All destination consumers compose **service + http + rabbitmq + postgres** plus
their own block.

#### webhook-sink v1

Source: [`sync/destinations/webhook-sink/v1/src/config.ts`](../../sync/destinations/webhook-sink/v1/src/config.ts).

| Variable | Status | Default |
| --- | --- | --- |
| `POLARIS_WEBHOOK_SINK_CONSUMER_GROUP` | optional | `polaris-webhook-sink-v1` |
| `POLARIS_WEBHOOK_SINK_CONCURRENCY` | optional | `4` |
| `POLARIS_WEBHOOK_SINK_REQUEST_TIMEOUT_MS` | optional | `5000` |
| `POLARIS_WEBHOOK_SINK_ALLOW_REPLAY` | optional | `false` |

#### meta-capi v1

Source: [`sync/destinations/meta-capi/v1/src/config.ts`](../../sync/destinations/meta-capi/v1/src/config.ts).

| Variable | Status | Default |
| --- | --- | --- |
| `POLARIS_META_CAPI_CONSUMER_GROUP` | optional | `polaris-meta-capi-v1` |
| `POLARIS_META_CAPI_CONCURRENCY` | optional | `4` |
| `POLARIS_META_CAPI_REQUEST_TIMEOUT_MS` | optional | `5000` |
| `POLARIS_META_CAPI_ALLOW_REPLAY` | optional | `false` |
| `POLARIS_META_CAPI_GRAPH_HOST` | optional | `graph.facebook.com` |

#### tiktok v1

Source: [`sync/destinations/tiktok/v1/src/config.ts`](../../sync/destinations/tiktok/v1/src/config.ts).

| Variable | Status | Default |
| --- | --- | --- |
| `POLARIS_TIKTOK_CONSUMER_GROUP` | optional | `polaris-tiktok-v1` |
| `POLARIS_TIKTOK_CONCURRENCY` | optional | `4` |
| `POLARIS_TIKTOK_REQUEST_TIMEOUT_MS` | optional | `5000` |
| `POLARIS_TIKTOK_ALLOW_REPLAY` | optional | `false` |
| `POLARIS_TIKTOK_API_HOST` | optional | `business-api.tiktok.com` |

### polaris CLI

Source: [`apps/polaris-cli/src/config.ts`](../../apps/polaris-cli/src/config.ts).

Operator tool, not a service. Reads its own ad-hoc variables for the
control-plane API client + operator-token gate.

| Variable | Status | Notes |
| --- | --- | --- |
| `POLARIS_API_URL` | required when no profile is selected | Control-plane API base URL. |
| `POLARIS_TOKEN` | required for default profile (secret) | Bearer token for control-plane API. |
| `POLARIS_OPERATOR_TOKEN` | required for production mutations (secret) | Operator token; checked by the gate. |
| `POLARIS_PROFILE` | optional | Active profile from `~/.polaris/config.toml`. |
| `POLARIS_OUTPUT` | optional | `human` or `json`. |
| `POLARIS_LOG_LEVEL` | optional | Defaults to `warn`. |
| `POLARIS_DEBUG` | optional | `1` prints stack traces. |
| `POLARIS_CATALOG_ROOT` | optional | Repo root; the CLI walks upward from cwd by default. |
| `POLARIS_DATABASE_URL` | optional | CLI-specific override; falls back to `DATABASE_URL`. |
| `POLARIS_ENV` | optional | Effective environment for the production-mutation gate. |
| `POLARIS_GIT_SHA` / `POLARIS_BUILD_TIME` | optional | Shown by `polaris --version`. |

The CLI never stores its bearer token in the config file. The TOML at
`~/.polaris/config.toml` points each profile at the **env-var name**
that holds the token; the token itself lives only in the operator's
shell environment.

## Secret-bearing variables (full list)

Every variable that may carry a secret is named below. None of these
should ever appear in `.env.example` with a real value. The production
deployment's orchestrator injects them at boot.

| Variable | Used by |
| --- | --- |
| `POLARIS_POSTGRES_PASSWORD` | every service touching PostgreSQL |
| `POLARIS_REDIS_PASSWORD` | ingester-api (optional unless Redis ACL is on) |
| `POLARIS_RABBITMQ_URL` | every service touching RabbitMQ (credentials are in the URL) |
| `POLARIS_CLICKHOUSE_SERVICE_PASSWORD` | operators / future analytics services |
| `POLARIS_CLICKHOUSE_OPERATOR_PASSWORD` | operators / replay-rebuild workflows |
| `POLARIS_GEOIP_LICENSE_KEY` | the geoip refresh cron job (never any service) |
| `POLARIS_TOKEN` | `polaris` CLI |
| `POLARIS_OPERATOR_TOKEN` | `polaris` CLI for production mutations |

The platform also stores **destination credentials** (Meta CAPI tokens,
TikTok keys, generic webhook secrets) and **per-project secret values**
in the control-plane database as plaintext. Those are not
Polaris-platform variables and are not listed in `.env.example` — they
are operator data, set with `polaris destinations create
--secret-value` / `polaris config set --secret` and rotated with
`polaris destinations rotate-secret`. See the
[secret rotation runbook](../operations/secret-rotation.md).

## Composition map (cheat sheet)

```text
                    service  http  postgres  redis  rabbitmq  ingester  proc   consumer  + local
ingester-api          x       x       x        x       x         x                       authCache, ingest, rateLimit
control-plane-api     x       x       x                                                  (none)
sync-identity         x       x       x                x                  x              resolver
sync-enrichment       x       x       x                x                  x              enrichment
sessionizer           x       x                        x                  x              sessionizer
attribution-engine    x       x                        x                  x              attributionEngine
webhook-sink          x       x       x                x                          x      sink
meta-capi             x       x       x                x                          x      meta
tiktok                x       x       x                x                          x      tiktok
```

The geoip refresh job is deliberately absent from that map: it composes
none of the shared blocks. It is a cron entry with four variables of its
own, not a service — see "jobs" above.
