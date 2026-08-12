# Polaris Blueprints

Runnable Next.js apps that answer "how do I get events into Polaris from
here?". Read one, copy the two or three files that matter, delete the rest.

| Blueprint                            | Answers                                                            | Port |
| ------------------------------------ | ------------------------------------------------------------------ | ---- |
| [`01-storefront`](./01-storefront)   | all of it: browser direct, browser relayed, and backend, one visitor | 3641 |

There used to be three apps here, one per path. They were easier to skim and
they taught the wrong thing: real deployments run a browser path *and* a
backend path, and the interesting part is how the two agree about who the
visitor is. Three isolated apps could describe that and never show it. One
app can, so there is one.

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

That installs the workspace, builds the packages the blueprint links against,
creates the `polaris` role and database, applies the PostgreSQL and ClickHouse
migrations, declares the RabbitMQ topology, and then seeds — the `storefront`
project, its `storefront-web` / `payments-api` sources, and the browser origin
allow-list entry the direct transport needs.

Seeding is `bin/setup`, and it is idempotent. Re-run just that part with
`make seed` after changing anything under `catalog/`.

**2. Issue both keys.** The blueprint produces from two sources, so it wants
one of each. Each command prints its token exactly once — only an argon2id
hash is stored, so a lost token is reissued, never recovered:

```bash
make api_key
```

```bash
make api_key KEY_SOURCE=payments-api KEY_TYPE=backend
```

The first is the web key, used by the browser paths; the second is the backend
key, used by the Node SDK. `KEY_PROJECT` and `KEY_ENV` override the rest.

**3. Start the ingester** and leave it running:

```bash
make dev-ingester
```

It listens on **4000**, which is what `.env.example` points at.

Prefer `make dev-ingester` over `make dev-all` while you are working in a
blueprint — `dev-all` starts one `tsx watch` supervisor per service, and
fourteen of those hold a large share of the machine's file-watch capacity for
nothing you need here. `make dev-stop` clears a stack you left running.

The blueprint does not depend on that going well, though. Next.js watches its
config files and `.next/dev` through Watchpack, which on macOS means FSEvents;
on a machine short of watch capacity that watcher fails with `EMFILE`, and
Watchpack reports a failed watcher as a *deleted* directory. Next.js concludes
`.next/dev` was removed, restarts to recover, and lands in the same failure —
forever, with nothing in the loop naming the real cause. `WATCHPACK_POLLING=true`
in the `dev` script polls those few paths rather than watching them, so the
loop has nothing to start from. Turbopack watches the source tree itself and is
unaffected, so hot reload is unchanged.

### Running on a different port

The ingester checks the `Origin` header of browser-sent batches against a
per-source allow-list and denies anything it does not know. That applies to
the **direct** transport only — the relay and the backend paths reach the
ingester server-side, with no `Origin` header to check.

`bin/setup` seeds the blueprint's documented port. If you move it, seed yours
too — and move it in `bin/setup` as well, or the next fresh checkout will
seed the old one:

```bash
echo 'POLARIS_DEV_ORIGINS=http://localhost:3000' >> .env.local && make seed
```

## Running the blueprint

It installs its own dependency tree. `--ignore-workspace` is required: the
blueprints deliberately sit outside `pnpm-workspace.yaml`, and without the
flag pnpm installs the monorepo instead and leaves the blueprint untouched.

```bash
cd blueprints/01-storefront && pnpm install --ignore-workspace
```

```bash
cp .env.example .env.local   # paste both tokens from above
pnpm dev
```

## Confirming an event actually landed

The ingester answers per event, so the first check is the HTTP response — the
blueprint surfaces it in the activity feed and in the dev-server log. After
that:

```bash
curl -s http://localhost:4000/metrics | grep polaris_ingest
```

RabbitMQ's management UI at <http://localhost:15672> (polaris / polaris) shows
the message reaching `raw.events`. If you also run the processors and
`clickhouse-sink`, `pnpm clickhouse:query event-daily-counts` closes the loop.

All three paths emit `checkout.started` with a different `flow_variant` —
`browser`, `server-action`, `route-handler` — so a query can tell them apart
once they are in ClickHouse.

### Watching it reach a destination

Destination consumers deliver to `destinations` rows, and a fresh checkout has
none — so `make dev-all` runs every vendor consumer and none of them sends
anything. That is the intended default (destinations are opt-in), and each
consumer says so on its `/metrics`:

```bash
curl -s http://localhost:5000/metrics | grep no_active_destinations
```

To see a real delivery, point a webhook destination at anything that answers
on localhost — the deliverer allows plain `http://` only there:

```bash
node -e 'require("http").createServer((q,s)=>{let b="";q.on("data",c=>b+=c);q.on("end",()=>{console.log(b);s.end("{}")})}).listen(4321)'
```

Add `POLARIS_WEBHOOK_TEST_URL=http://localhost:4321/hook` to `.env.local`,
restart `make dev-all` so the consumers pick it up, then:

```bash
./polaris destinations create --project storefront --env development --vendor webhook --instance-label local-test-sink --secret-ref env:POLARIS_WEBHOOK_TEST_URL
```

This walkthrough is the one place that wants the full `dev-all` stack, which
is also the stack that starves the blueprint of file watches. Start the
blueprint first and leave it running: `dev-all` takes what is left, and the
blueprint only needs its watches at startup.

The next event arrives on 4321 within a few seconds, and `select * from
delivery_records` in PostgreSQL records the attempt. Note `--vendor webhook`,
not `webhook-sink`: the vendor literal is the one in
`consumers/webhook-sink/v1/consumer.manifest.yaml`, and it is what the
consumer matches its destination rows on.

## How the blueprint depends on the SDKs

Both SDKs are workspace packages that are not published yet, so the blueprint
links to their built output:

```json
"@polaris/web-sdk": "link:../../packages/web-sdk"
```

Two consequences. Re-run `pnpm build` at the repo root after changing SDK
source, or the blueprint keeps using the old `dist`. And `next.config.ts` pins
Turbopack's root at the repo root, because the linked modules resolve above
the app directory. An application installing the SDKs from the internal
registry needs neither.

## What this is not

A demonstration of the SDK contract, not a production template. No consent
gating, no error boundaries, no rate limiting on the relay route. Shipping
both browser transports at once is a blueprint affordance so they can be
compared — a real app picks one and deletes the other. The blueprint's own
README lists what it leaves to you.
