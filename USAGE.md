# Polaris Local Usage

Polaris is not a browser UI. It is a local event-ingestion platform made of:

- a Fastify ingester API
- a PostgreSQL-backed operator CLI
- Redis for short-window dedupe
- RabbitMQ for event streaming
- ClickHouse for analytics storage

## 1. Start the Local Stack

From the repo root:

```bash
make setup
```

`make setup` installs dependencies, builds the shared packages, and brings the
schema up: the PostgreSQL role and database, its migrations, the ClickHouse
schema, the RabbitMQ user and topology, and the dev seeds. It expects those
four services to be reachable on their default localhost ports — `make
docker-up` starts them in containers if you are not running them natively.

Check service health:

```bash
docker compose ps
```

All four services should be healthy:

- `polaris-postgres`
- `polaris-redis`
- `polaris-rabbitmq`
- `polaris-clickhouse`

## 2. Build the Workspace

```bash
pnpm build
```

The CLI and services run from `dist/`, so build before using them directly.

## 3. Configure CLI Environment

Run the CLI through `./polaris` at the repo root. It builds the CLI if `dist/`
is missing or stale, then loads `.env.local` — the same file `make` includes —
so a PostgreSQL connection string is already in place:

```bash
./polaris --help
```

Every v1 command talks to PostgreSQL directly and needs a connection string.
There is no built-in localhost default: a CLI that can mutate production must
not guess which database it is pointed at. To run the binary without the
shortcut, export one yourself:

```bash
export POLARIS_DATABASE_URL='postgres://polaris:polaris@localhost:5432/polaris?sslmode=disable'
node apps/polaris-cli/dist/bin/polaris.js projects list --from-catalog
```

`POLARIS_API_URL` and `POLARIS_TOKEN` are for the HTTP boundary only. No v1
command uses it, so leave them unset unless you are exercising that path.

## 4. Seed the Catalog

The repo ships a sample `storefront` project and two sources:

- `storefront-web`
- `payments-api`

Inspect catalog files without touching PostgreSQL:

```bash
./polaris projects list --from-catalog
./polaris sources list --from-catalog
```

Materialize them into PostgreSQL:

```bash
./polaris projects sync
./polaris sources sync
```

## 5. Create an API Key

```bash
./polaris keys create \
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

`make dev` runs the whole platform — every app, processor, and consumer, the
ingester among them on port **4000** — and one Ctrl-C stops all of it. That is
the normal way to have Polaris running locally, and the rest of this document
works against it if you read `8080` as `4000`.

The explicit form below is here because this walkthrough is about seeing one
service work in isolation: nothing but the ingester, every input named on the
command line, on the port the smoke runbook uses.

In one terminal:

```bash
POLARIS_SERVICE_NAME=ingester-api \
POLARIS_ENV=local \
POLARIS_HTTP_PORT=8080 \
POLARIS_POSTGRES_HOST=127.0.0.1 \
POLARIS_POSTGRES_DATABASE=polaris \
POLARIS_POSTGRES_USER=polaris \
POLARIS_POSTGRES_PASSWORD=polaris \
POLARIS_RABBITMQ_URL=amqp://polaris:polaris@localhost:5672 \
POLARIS_RABBITMQ_CLIENT_ID=ingester-api-local \
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
./polaris audit list --limit 10
```

If you did not export the CLI env vars, run:

```bash
POLARIS_API_URL=http://localhost:8080 \
POLARIS_TOKEN=local-dev \
POLARIS_DATABASE_URL='postgres://polaris:polaris@localhost:5432/polaris?sslmode=disable' \
./polaris audit list --limit 10
```

## ClickHouse Note

`make setup` does not run ClickHouse schema bootstrap. The documented command is:

```bash
pnpm clickhouse:bootstrap-local
```

At the time this usage note was written, local bootstrap can fail because the
ClickHouse DDL uses `ON CLUSTER '{cluster}'` while the local container does not
run Keeper/ZooKeeper. The ingester, CLI, PostgreSQL, Redis, and RabbitMQ path is
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
