# Polaris Samples

Three small Next.js apps, each one a working answer to "how do I get events
into Polaris from here?". They are blueprints: read one, copy the two or
three files that matter, delete the rest.

| Sample                                     | Answers                                        | SDK                 | Key            | Port |
| ------------------------------------------ | ---------------------------------------------- | ------------------- | -------------- | ---- |
| [`01-web-events`](./01-web-events)          | browser events, posted straight to the ingester | `@polaris/web-sdk`  | web, in bundle | 3000 |
| [`02-server-events`](./02-server-events)    | backend events from route handlers and actions | `@polaris/node-sdk` | backend, server-side | 3001 |
| [`03-proxy-ingest`](./03-proxy-ingest)      | browser events relayed through your own origin | `@polaris/web-sdk`  | web, server-side | 3002 |

Most real deployments run **01 or 03** for the browser and **02** alongside
it for anything involving money, entitlements, or a webhook.

## One-time setup

Everything below runs from the repo root, once. Development is bare metal:
PostgreSQL, RabbitMQ, Redis, and ClickHouse are expected at their default
localhost endpoints. If you would rather run those in containers, `make
docker-up` brings them up and the rest is unchanged.

**1. Bootstrap and seed** (see
[getting-started](../docs/development/getting-started.md) for the long
version):

```bash
make setup
```

That installs the workspace, builds the packages the samples link against,
creates the `polaris` role and database, applies the PostgreSQL and
ClickHouse migrations, declares the RabbitMQ topology, and then seeds — the
`storefront` project, its `storefront-web` / `payments-api` sources, and the
browser origin allow-list entry `01-web-events` needs.

Seeding is `bin/setup`, and it is idempotent. Re-run just that part with
`make seed` after changing anything under `catalog/`.

**2. Issue the keys.** Each command prints its token exactly once — only an
argon2id hash is stored, so a lost token is reissued, never recovered:

```bash
make api_key
```

```bash
make api_key KEY_SOURCE=payments-api KEY_TYPE=backend
```

The first is the web key for samples 01 and 03; the second is the backend key
for sample 02. `KEY_PROJECT` and `KEY_ENV` override the rest.

**3. Start the ingester** and leave it running:

```bash
make dev-ingester
```

It listens on **4000**, which is what every sample's `.env.example` points at.

### Running a browser app on a different port

The ingester checks the `Origin` header of browser-sent batches against a
per-source allow-list and denies anything it does not know, so sample 01 has
to be allow-listed before its events are accepted. The seed covers its
documented port. If you moved it, add yours to `.env.local` at the repo root
and re-seed:

```bash
echo 'POLARIS_DEV_ORIGINS=http://localhost:3641' >> .env.local && make seed
```

Samples 02 and 03 reach the ingester server-side — no `Origin` header, so
nothing to allow-list.

## Running a sample

Each app installs its own dependency tree. `--ignore-workspace` is required:
the samples deliberately sit outside `pnpm-workspace.yaml`, and without the
flag pnpm installs the monorepo instead and leaves the sample untouched.

```bash
cd samples/01-web-events && pnpm install --ignore-workspace
```

```bash
cp .env.example .env.local   # paste the token you issued above
pnpm dev
```

## Confirming an event actually landed

The ingester answers per event, so the first check is the HTTP response —
the samples surface it in the page or in the dev-server log. After that:

```bash
curl -s http://localhost:4000/metrics | grep polaris_ingest
```

RabbitMQ's management UI at <http://localhost:15672> (polaris / polaris)
shows the message reaching `raw.events`. If you also run the processors and
`clickhouse-sink`, `pnpm clickhouse:query event-daily-counts` closes the
loop.

## How the samples depend on the SDKs

Both SDKs are workspace packages that are not published yet, so each sample
links to the built output:

```json
"@polaris/web-sdk": "link:../../packages/web-sdk"
```

Two consequences. Re-run `pnpm build` at the repo root after changing SDK
source, or the samples keep using the old `dist`. And `next.config.ts` pins
Turbopack's root at the repo root, because the linked module resolves above
the app directory. An application installing `@polaris/web-sdk` from the
internal registry needs neither.

## What these are not

They are demonstrations of the SDK contract, not production templates. No
consent gating, no error boundaries, no rate limiting on the relay route in
sample 03. Each README lists what its blueprint leaves to you.
