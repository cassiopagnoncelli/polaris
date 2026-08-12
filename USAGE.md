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

`make setup` brings this machine to the state the repo describes. It installs
dependencies, builds the shared packages, **drops every Polaris store**, and
rebuilds: the PostgreSQL role and database, its migrations, the ClickHouse
schema, the RabbitMQ user and topology, the dev seeds, and the two API keys
the storefront blueprint uses. It expects the four services to be reachable on
their default localhost ports — `make docker-up` starts them in containers if
you are not running them natively.

The drop is the point, not a mode. Every step used to be additive, so a source
deleted from the catalog kept routing and an edited migration never applied —
what you got depended on the machine's history rather than the repo. Dropping
first is what makes the result reproducible.

It is therefore **not** the command for picking up new migrations after a
`git pull`. That is:

```bash
make db-migrate
```

Two narrower forms, when you want one half of it:

```bash
make destroy   # drop every Polaris store, rebuild nothing
make seed      # re-run the catalog syncs and origin allow-list; destroys nothing
```

`make setup` refuses to run unless every endpoint is on localhost and
`POLARIS_ENV` is not a deployed environment.

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

`make setup` already did this — the steps here are what it runs, for when you
want one of them on its own.

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

`make seed` runs both, plus the browser origin allow-list that `sources sync`
has no surface for. Reach for it after editing `catalog/`.

## 5. Create an API Key

`make setup` issues two — a web key for `storefront-web` and a backend key for
`payments-api` — and writes them to `blueprints/api-key`, which the storefront
blueprint reads directly. A fresh install needs no copying.

That file is regenerated on every `make setup`, because the run that writes it
also drops the keys from the previous one. A token pasted somewhere by hand
goes stale then, and a stale token does not announce itself — it just makes
every request 401.

To issue one by hand:

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

`make setup` runs the ClickHouse schema bootstrap as one of its steps. To
re-run just that step:

```bash
pnpm clickhouse:bootstrap-local
```

The DDL uses `ON CLUSTER '{cluster}'`, which needs macros, a cluster
definition, and Keeper on the server. The bootstrap script detects when those
are missing on a bare-metal ClickHouse and writes the `polaris-*.xml` config
files itself before applying the schema, so a plain local install works.

Useful ClickHouse smoke commands after bootstrap:

```bash
pnpm clickhouse:query ping
pnpm clickhouse:query schema
pnpm clickhouse:query ingest-log --limit 20
pnpm clickhouse:query raw-count
pnpm clickhouse:query event-daily-counts
```
