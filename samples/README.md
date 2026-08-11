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

Everything below runs from the repo root, once.

**1. Bring up the platform** (see
[getting-started](../docs/development/getting-started.md) for the long
version):

```bash
pnpm install && docker compose up -d --wait && pnpm db:migrate
```

**2. Build the workspace.** The samples link to `packages/*/dist`, and the
CLI runs from `dist` too, so this is not optional:

```bash
pnpm build
```

**3. Materialize the catalog** — the sample `storefront` project and its
`storefront-web` / `payments-api` sources:

```bash
export POLARIS_API_URL=http://localhost:8080
export POLARIS_TOKEN=local-dev
export POLARIS_DATABASE_URL='postgres://polaris:polaris@localhost:5432/polaris?sslmode=disable'
node apps/polaris-cli/dist/bin/polaris.js projects sync
node apps/polaris-cli/dist/bin/polaris.js sources sync
```

**4. Issue the keys.** Each command prints its token exactly once — only an
argon2id hash is stored, so a lost token is reissued, never recovered:

```bash
node apps/polaris-cli/dist/bin/polaris.js keys create \
  --project storefront --env development --source storefront-web --type web
```

```bash
node apps/polaris-cli/dist/bin/polaris.js keys create \
  --project storefront --env development --source payments-api --type backend
```

**5. Allow the browser origin** — only for `01-web-events`, which posts from
the browser to a different origin. The ingester denies unknown origins by
default, and there is no CLI surface for the allow-list yet:

```bash
docker compose exec -T postgres psql -U polaris -d polaris -c "INSERT INTO source_allowed_origins (project_id, source_id, environment, origin) VALUES ('storefront', 'storefront-web', 'development', 'http://localhost:3000') ON CONFLICT DO NOTHING;"
```

**6. Start the ingester** and leave it running:

```bash
POLARIS_HTTP_PORT=8080 pnpm --filter @polaris/ingester-api run start
```

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
curl -s http://localhost:8080/metrics | grep polaris_ingest
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
