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

**1. Install** (see
[getting-started](../docs/development/getting-started.md) for the long
version):

```bash
make setup
```

That installs the workspace, builds the packages the blueprint links against,
drops every Polaris store, and rebuilds: the `polaris` role and database, the
PostgreSQL and ClickHouse migrations, the RabbitMQ topology, the seeds — the
`storefront` project, its `storefront-web` / `payments-api` sources, and the
browser origin allow-list entry the direct transport needs — and both API keys.

Dropping first is what makes the result depend on the repo rather than on this
machine's history. It also means the keys are reissued every run, which is why
step 2 below is not a step you have to do.

`make seed` re-runs the catalog syncs and the allow-list on their own, without
destroying anything. Reach for it after changing something under `catalog/`.

**2. Nothing.** `make setup` already issued the blueprint's two keys — a web
key sending as `storefront-web`, a backend key sending as `payments-api` — and
wrote them to `01-storefront/.env.development.local`, which Next loads ahead
of your `.env.local`. There is nothing to copy, and nothing to copy again
after the next `make setup`.

That ordering is the whole design. Reissued keys have to beat pasted ones,
because `make setup` drops the old keys as it issues new ones — so a token you
pasted somewhere is stale from that moment, and a stale token does not
announce itself, it just 401s. Rather than enforce that with code, the
installer writes to the file Next already ranks higher. Your `.env.local` is
for choices; the generated file is for values.

The one exception is `NEXT_PUBLIC_POLARIS_API_KEY`, which direct mode needs
and which is deliberately left to you: setting it inlines a token into the JS
bundle, and deciding that is the point of the web-vs-backend split below.
Uncomment one line in `.env.local` to opt in:

```
NEXT_PUBLIC_POLARIS_API_KEY=$POLARIS_WEB_API_KEY
```

Note the `$`. That references the issued token instead of copying it, so it
cannot go stale either — the decision to publish is yours and persists, the
value stays the installer's. Leave it commented to run relay-only.

To reissue by hand — each command prints its token exactly once, and only an
argon2id hash is stored, so a lost token is reissued and never recovered:

```bash
make api_key
```

```bash
make api_key KEY_SOURCE=payments-api KEY_TYPE=backend
```

**3. Start the platform** and leave it running:

```bash
make dev
```

That is the whole dev stack — the ingester on **4000**, which is what
`.env.example` points at, plus the processors and consumers behind it. There
is no smaller target to reach for: `make dev` stops whatever it finds already
running before it starts, and Ctrl-C stops everything it started.

A blueprint only needs the ingester, and thirteen `tsx watch` supervisors do
hold a large share of the machine's file-watch capacity. The blueprint does
not depend on winning that race, though. Next.js watches its
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

`bin/setup` reads the port out of this blueprint's own `dev` script and seeds
that, so moving the port in `package.json` is enough — there is no second copy
to keep in step. To allow-list an additional origin without moving the
documented one: 

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
none — so `make dev` runs every vendor consumer and none of them sends
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
restart `make dev` so the consumers pick it up, then:

```bash
./polaris destinations create --project storefront --env development --vendor webhook --instance-label local-test-sink --secret-ref env:POLARIS_WEBHOOK_TEST_URL
```

Start the blueprint before the stack and leave it running: `make dev` takes
what is left of the machine's file watches, and the blueprint only needs its
own at startup.

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
