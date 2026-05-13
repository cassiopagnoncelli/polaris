# Polaris Local Usage

Polaris is not a browser UI. It is a local event-ingestion platform made of:

- a Fastify ingester API
- a PostgreSQL-backed operator CLI
- Redis for short-window dedupe
- Redpanda for event streaming
- ClickHouse for analytics storage

## 1. Start the Local Stack

From the repo root:

```bash
make setup
```

`make setup` installs dependencies, starts Docker Compose, and applies
PostgreSQL migrations.

Check service health:

```bash
docker compose ps
```

All four services should be healthy:

- `polaris-postgres`
- `polaris-redis`
- `polaris-redpanda`
- `polaris-clickhouse`

## 2. Build the Workspace

```bash
pnpm build
```

The CLI and services run from `dist/`, so build before using them directly.

## 3. Configure CLI Environment

The CLI currently requires control-plane-style environment variables even for
commands that read/write PostgreSQL directly.

```bash
export POLARIS_API_URL=http://localhost:8080
export POLARIS_TOKEN=local-dev
export POLARIS_DATABASE_URL='postgres://polaris:polaris@localhost:5432/polaris?sslmode=disable'
```

## 4. Seed the Catalog

The repo ships a sample `storefront` project and two sources:

- `storefront-web`
- `payments-api`

Inspect catalog files without touching PostgreSQL:

```bash
node apps/polaris-cli/dist/bin/polaris.js projects list --from-catalog
node apps/polaris-cli/dist/bin/polaris.js sources list --from-catalog
```

Materialize them into PostgreSQL:

```bash
node apps/polaris-cli/dist/bin/polaris.js projects sync
node apps/polaris-cli/dist/bin/polaris.js sources sync
```

## 5. Create an API Key

```bash
node apps/polaris-cli/dist/bin/polaris.js keys create \
  --project storefront \
  --env development \
  --source storefront-web \
  --type web
```

The command prints a raw token exactly once. Save it in your shell:

```bash
export POLARIS_API_KEY='paste_the_key_here'
```

The stored database value is only an argon2id hash; plaintext cannot be
recovered later.

## 6. Start the Ingester API

In one terminal:

```bash
POLARIS_SERVICE_NAME=ingester-api \
POLARIS_ENV=local \
POLARIS_HTTP_PORT=8080 \
POLARIS_POSTGRES_HOST=127.0.0.1 \
POLARIS_POSTGRES_DATABASE=polaris \
POLARIS_POSTGRES_USER=polaris \
POLARIS_POSTGRES_PASSWORD=polaris \
POLARIS_REDPANDA_BROKERS=127.0.0.1:19092 \
POLARIS_REDPANDA_CLIENT_ID=ingester-api-local \
POLARIS_REDIS_HOST=127.0.0.1 \
pnpm --filter @polaris/ingester-api run start
```

In another terminal, check the service:

```bash
curl http://localhost:8080/health
curl http://localhost:8080/ready
```

## 7. Send a Test Event

Use the active `page.viewed` v2 schema. The envelope requires all `identity`
and `context` keys; use `null` for unknown values.

```bash
curl -s -X POST http://localhost:8080/v1/events \
  -H "Content-Type: application/json" \
  -H "X-Polaris-Api-Key: $POLARIS_API_KEY" \
  -d '{
    "events": [{
      "event_id": "0193e0d3-0000-7000-8000-000000000003",
      "event": "page.viewed",
      "schema_version": 2,
      "occurred_at": "2026-05-12T12:00:00.000Z",
      "source": {
        "id": "storefront-web",
        "type": "browser",
        "sdk": "curl",
        "sdk_version": "0.0.1"
      },
      "identity": {
        "anonymous_id": "anon-001",
        "session_id": "sess-001",
        "customer_id": null,
        "device_id": null
      },
      "context": {
        "ip": null,
        "user_agent": null,
        "locale": null,
        "page": {
          "url": "https://example.com/",
          "path": "/",
          "title": "Home",
          "referrer": null
        },
        "campaign": null
      },
      "properties": {
        "path": "/",
        "search": null,
        "title": "Home",
        "referrer": null
      }
    }]
  }'
```

A successful ingest returns the event under `accepted`. The ingester also logs:

```text
message="ingest accepted"
```

If you retry the same payload, change `event_id`; Redis dedupe may reject a
reused event id as a duplicate.

## 8. Inspect Metrics and Audit Records

Prometheus metrics:

```bash
curl http://localhost:8080/metrics
```

Recent audit records:

```bash
node apps/polaris-cli/dist/bin/polaris.js audit list --limit 10
```

If you did not export the CLI env vars, run:

```bash
POLARIS_API_URL=http://localhost:8080 \
POLARIS_TOKEN=local-dev \
POLARIS_DATABASE_URL='postgres://polaris:polaris@localhost:5432/polaris?sslmode=disable' \
node apps/polaris-cli/dist/bin/polaris.js audit list --limit 10
```

## ClickHouse Note

`make setup` does not run ClickHouse schema bootstrap. The documented command is:

```bash
pnpm clickhouse:bootstrap-local
```

At the time this usage note was written, local bootstrap can fail because the
ClickHouse DDL uses `ON CLUSTER '{cluster}'` while the local container does not
run Keeper/ZooKeeper. The ingester, CLI, PostgreSQL, Redis, and Redpanda path is
usable without that ClickHouse bootstrap; analytics queries need the local DDL
bootstrap issue fixed first.

Useful ClickHouse smoke commands after bootstrap is fixed:

```bash
pnpm clickhouse:query ping
pnpm clickhouse:query schema
pnpm clickhouse:query ingest-log --limit 20
pnpm clickhouse:query raw-count
pnpm clickhouse:query event-daily-counts
```
