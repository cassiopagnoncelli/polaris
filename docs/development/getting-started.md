# Getting Started

This runbook is the day-one onboarding doc for a Polaris engineer. It answers
"I just cloned the repo — what do I do?" and points you at the other docs
once you have a working local stack.

For background, read these in order before you touch code:

- [Polaris Documentation](../README.md) — the index.
- [Architecture Overview](../architecture/00-overview.md) — the moving pieces.
- [Claude Instructions](../instructions/claude.md) — the rules every contributor
  follows; the same file governs both humans and agents.

This page is intentionally a **navigation doc**. It links to the SDK handbook,
API docs, CI doc, smoke runbook, and audit/export runbook rather than
duplicating their content.

## Prerequisites

| Tool         | Required version    | Why                                                             |
| ------------ | ------------------- | --------------------------------------------------------------- |
| Node.js      | `>=22.0.0` (Active LTS) | Pinned in [`package.json`](../../package.json) `engines.node`.   |
| pnpm         | `10.30.0`           | Pinned in `packageManager`. Other versions are blocked at install. |
| Docker       | recent (24+)        | Runs the four-service local stack (`docker compose up -d`).       |
| `psql`       | recent              | The smoke seed step and ad-hoc DB inspection shell out to `psql`. Install via `brew install postgresql` or `apt-get install postgresql-client`. |
| `dbmate`     | recent              | Applies PostgreSQL migrations. The `db:migrate` script invokes it from `packages/shared-db`. |
| Make         | optional            | Thin wrapper around `pnpm` + `docker compose`. See `make help`.    |

Node and pnpm are also pinned at the top of each GitHub Actions workflow file
(see [CI](./ci.md) for the version-bump procedure).

If you use `nvm`, `corepack enable && corepack prepare pnpm@10.30.0 --activate`
is the minimum bootstrap once Node 22 is selected.

## First-time setup

From the repo root:

```bash
# 1. Bring up the local data-path stack (RabbitMQ, Postgres, Redis, ClickHouse).
#    Skip if you run them natively — setup assumes the default localhost ports
#    either way.
make docker-up

# 2. Install Polaris.
make setup
```

`make setup` is the whole thing: dependencies, package and CLI builds, the
PostgreSQL role and database, migrations, the ClickHouse schema and local
users, the RabbitMQ user and topology, the catalog seeds, and the storefront
blueprint's two API keys. It prints what it produced when it finishes.

It **drops every Polaris store first**, every time, so what you end up with is
a function of the repo rather than of this machine's history. That makes it
the wrong command for picking up new migrations after a `git pull` — use
`pnpm db:migrate` (or `make db-migrate`) for that. `make destroy` is the
teardown on its own; `make seed` re-runs the catalog syncs without destroying
anything.

Setup refuses to run unless every endpoint is on localhost and `POLARIS_ENV`
is not a deployed environment. See `bin/setup`'s header for the reasoning, and
`make help` for the individual steps.

Verify:

```bash
make dev                                 # run the platform, Ctrl-C stops it
pnpm smoke:vertical-slice                # event -> ingester -> RabbitMQ -> ClickHouse
```

Or inspect each service directly:

```bash
docker compose ps                        # all four services in "healthy" state
pnpm db:status                           # dbmate prints "[X] applied" rows
pnpm clickhouse:query schema             # lists polaris.* tables and roles
```

The four local services and their host ports default to:

| Service     | Host port  | Override env var                       |
| ----------- | ---------- | -------------------------------------- |
| RabbitMQ (AMQP)   | `5672`  | `RABBITMQ_AMQP_HOST_PORT`       |
| RabbitMQ (mgmt)   | `15672` | `RABBITMQ_MANAGEMENT_HOST_PORT` |
| PostgreSQL  | `5432`     | `POSTGRES_HOST_PORT`                   |
| Redis       | `6379`     | `REDIS_HOST_PORT`                      |
| ClickHouse  | `8123` (HTTP), `9000` (native) | `CLICKHOUSE_HTTP_HOST_PORT`, `CLICKHOUSE_NATIVE_HOST_PORT` |

The compose definitions live in [`docker-compose.yml`](../../docker-compose.yml).
See the inline comments there for the rationale (single-broker RabbitMQ, no
ClickHouse Keeper, ephemeral Redis).

## Daily workflow

### Run the platform

```bash
make dev
```

That is the only command for running services locally. It builds the shared
packages, prints the roster it is about to start (every app, processor, and
consumer, with the port each one listens on), and runs them under `tsx watch`.
Ctrl-C stops all of them — process groups, not best effort, so nothing is left
holding a port. Starting it again is always safe: it clears any stack it finds
still running, including one a previous crash left behind.

Where a processor has more than one version directory, `make dev` runs the
newest. Older versions stay runnable by name (below) for replay work; they
pin the same port, so a stack cannot run both.

The implementation is [`bin/dev`](../../bin/dev), and its header is the long
version of this paragraph.

### Run one service on its own

Nothing about `make dev` is required to run a single service — the package
scripts are still there, and take an explicit port:

```bash
# Override POLARIS_HTTP_PORT if you want the smoke runner's default (8080).
POLARIS_HTTP_PORT=8080 pnpm --filter @polaris/ingester-api run start
```

Entry point: [`apps/ingester-api/src/server.ts`](../../apps/ingester-api/src/server.ts).
Defaults: `POLARIS_HTTP_HOST=0.0.0.0`, `POLARIS_HTTP_PORT=3000` (from
[`packages/shared-config`](../../packages/shared-config/)). The smoke runbook
and CI workflow both expect the ingester on `8080`; the platform default
of `3000` is fine for ad-hoc usage but you'll override it when you want to
follow the smoke runbook step-by-step.

The analytics projector, for example (P4-001):

```bash
POLARIS_HTTP_PORT=8081 \
  pnpm --filter @polaris/processor-analytics-projector-v1 run start
```

The projector consumes `raw.events`, stamps `processor_name=analytics-projector`
+ `processor_version=v1` onto each envelope, and republishes to
`analytics.events`. From there, the ClickHouse ingestion interface table picks it up
into `analytics_ingest_log` and the materialized view propagates it into
`analytics_raw`.

For the full processor model, read
[Architecture: Processors and Replay](../architecture/05-processors-and-replay.md).

### Run the polaris CLI

The CLI is a thin client of the future control-plane API. Today, the data
commands (`projects`, `sources`, `keys`, `destinations`, `processors`, `audit`,
`export`) reach PostgreSQL directly through `@polaris/shared-db`. The
control-plane API service lands later in P6-000.

```bash
./polaris --help
```

`./polaris` at the repo root is the shortcut. It builds the CLI when `dist/`
is missing or stale, then loads `.env.local` before exec'ing it — the same
file `make` includes, so `DATABASE_URL` is set the way every other target
sees it. Variables you exported yourself always win over the file.

The underlying binary is `node apps/polaris-cli/dist/bin/polaris.js` after
`pnpm --filter @polaris/polaris-cli run build`. Use that form where the repo
root is not the working directory, and set `POLARIS_DATABASE_URL` or
`DATABASE_URL` yourself — every v1 command talks to PostgreSQL directly, and
the CLI never guesses a connection string.

The CLI's auth surface is documented in
[`apps/polaris-cli/README.md`](../../apps/polaris-cli/README.md) (profile
resolution, env vars, exit codes). For the audit/export-specific commands
see the [Audit and Export runbook](./audit-and-export.md).

## Testing

| Command                  | Scope                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `pnpm test`              | Workspace Vitest suite + `pnpm test:scripts`. No Docker. Fast.                     |
| `pnpm test:scripts`      | Just the repo-root `scripts/` Vitest suite (covers `lint-clickhouse-imports`).     |
| `pnpm typecheck`         | `tsc --noEmit` against the workspace, scripts, and tests projects.                 |
| `pnpm lint`              | Biome + `lint:clickhouse-imports` (the workspace-wide import rule).                |
| `pnpm format:check`      | Biome formatter check (no writes).                                                 |
| `pnpm test:smoke`        | Docker-gated Vitest wrapper around the vertical-slice smoke (`POLARIS_SMOKE_DOCKER=1` is forced on). |
| `pnpm smoke:vertical-slice` | The same end-to-end smoke driver, callable directly as a script.                   |

`pnpm test` is what CI's `test` job runs; `pnpm typecheck` / `pnpm lint` /
`pnpm format:check` are the `static-analysis` job. See [CI](./ci.md) for the
full gate list and how to opt a PR into integration runs.

The integration-tier suite (the full vertical-slice smoke under real Docker)
is covered by the [Vertical-Slice Smoke runbook](../implementation/runbooks/vertical-slice-smoke.md).
Run that runbook end-to-end whenever you touch the ingester, the SDK envelope
shape, the analytics-projector, ClickHouse DDL, or the RabbitMQ topic
resolver.

## Common tasks

### Issue an API key

```bash
./polaris keys create \
  --project storefront \
  --env development \
  --source storefront-web \
  --type web
```

The CLI prints the raw token (`polaris_ak_<uuidv7>.<secret>`) on stdout
**exactly once**. The platform stores only the argon2id hash. Capture the
output now; you cannot recover the plaintext later.

Other key commands: `polaris keys list`, `polaris keys revoke <api_key_id>`,
`polaris keys rotate <api_key_id>`. They all write an audit row in the same
transaction as the mutation — see [Audit and Export](./audit-and-export.md).

### Seed a project + source

The file-backed catalog at `catalog/projects/` and `catalog/sources/` is the
source of truth for project and source declarations. The CLI materializes
those declarations into PostgreSQL with two `sync` commands:

```bash
./polaris projects sync --dry-run
./polaris projects sync
./polaris sources sync --dry-run
./polaris sources sync
```

Removing a project from `catalog/projects/` is NOT a delete signal — the
sync planner ignores absences so that FK references stay sound. Deletes are
a separate workflow.

`polaris projects list --from-catalog` reads declarations straight from
disk without touching PostgreSQL; same for `sources list --from-catalog`.
Useful when you want to inspect the catalog on a fresh checkout before any
migrations run.

### Send a test event

The fastest sanity check is a hand-crafted POST. The full envelope shape
lives in [Event Contract](../architecture/01-event-contract.md):

```bash
curl -s -X POST http://localhost:8080/v1/events \
  -H "Content-Type: application/json" \
  -H "X-Polaris-Api-Key: $POLARIS_API_KEY" \
  -d '{
    "events": [
      {
        "event_id": "0193e0d3-0000-7000-8000-000000000001",
        "event": "page.viewed",
        "schema_version": 1,
        "occurred_at": "2026-05-12T12:00:00.000Z",
        "source": { "id": "storefront-web", "type": "web" },
        "identity": { "anonymous_id": "anon-001" },
        "context": {},
        "properties": { "path": "/", "title": "Home" }
      }
    ]
  }' | jq .
```

The ingester returns one per-event result (`status: accepted` or
`status: rejected` plus a stable reason code). It stamps `project_id`,
`environment`, and `ingested_at` from the API key — those fields are not
accepted from the client. The full response contract is in
[Ingestion and SDKs](../architecture/04-ingestion-and-sdks.md).

### Watch ingester logs

The ingester emits structured Pino JSON to stdout. If you started it in
the foreground, the logs are right there. If you backgrounded it, redirect
stdout when you start it:

```bash
POLARIS_HTTP_PORT=8080 \
  pnpm --filter @polaris/ingester-api run start \
  > /tmp/polaris-ingester.log 2>&1 &
tail -f /tmp/polaris-ingester.log | jq .
```

The ingester also exposes `/metrics` (Prometheus text exposition) and
`/health` / `/ready` (liveness/readiness). See
[Observability and Operations](../architecture/08-observability-and-operations.md).

### Inspect audit records

```bash
./polaris audit list --limit 20
./polaris audit show <audit_id>
```

Every mutating CLI command writes one audit row inside the same transaction
as the mutation. The full taxonomy of actions, snapshot shape, and the
`polaris export` commands that bulk-dump operational state are documented
in the [Audit and Export runbook](./audit-and-export.md).

### Activate the analytics projector for a project

```bash
./polaris processors enable analytics-projector \
  --version v1 \
  --project storefront \
  --env development
```

The CLI verifies the manifest exists on disk
(`sync/legacy/analytics-projector/v1/processor.manifest.yaml`) before it
upserts the activation row. Enables are idempotent. See "Versioned-processor
workflow" below for how to introduce a new version.

Note what this does and does not change. Processors run for every project by
default, so `enable` on a fresh install is a no-op that records intent. The
row that changes behaviour is the opposite one:

```bash
./polaris processors disable analytics-projector \
  --version v1 --project storefront --env development
```

Within about ten seconds the processor stops acting on that project's events
in that environment — it keeps running and skips them, counting each as
`polaris_processor_events_skipped_total{reason="processor_disabled"}`. See
[Architecture: Processors and Replay](../architecture/05-processors-and-replay.md)
"Activation" for why absence means allowed.

## Catalog workflow

Polaris is **file-heavy, database-light**. Two halves:

| Lives in files (semantic truth)                              | Lives in PostgreSQL (mutable runtime/control)              |
| ------------------------------------------------------------ | ---------------------------------------------------------- |
| Event schemas (`catalog/events/`, Zod in `packages/shared-schemas`) | API key hashes + metadata                                 |
| Event registry / catalog (`catalog/events/*/*.yaml`)         | `projects` rows (materialized from `catalog/projects/`)    |
| Forbidden-field policy (`catalog/policy/forbidden-fields.ts`) | `sources` rows (materialized from `catalog/sources/`)      |
| Project + source declarations (`catalog/projects/`, `catalog/sources/`) | `destination_instances` rows                             |
| Processor manifests + code (`processors/<name>/v<n>/`)       | `processor_activations` rows (runtime enable/disable)      |
| Destination consumer mappings + manifests (`consumers/<vendor>/v<n>/`) | `processor_runs`, `replay_jobs`, `delivery_records` rows |
| SQL DDL and migrations (`sql/`, `db/migrations/`)            | `audit_records`                                            |

The CLI's `--from-catalog` import path (on `projects list`, `projects show`,
`sources list`, `sources show`) lets you inspect declarations without a DB
connection. The `sync` subcommands are the one-way bridge from files into
PostgreSQL.

You do **not** ever round-trip the other way: PostgreSQL never redefines
event schemas, destination mappings, or processor semantics. If you find
yourself wanting that, stop and read
[Architecture: Control Plane](../architecture/02-control-plane.md).

## Versioned-processor workflow

Processor versions are immutable in semantic behaviour. Anything that can
change emitted-event meaning, fields, identity links, attribution outcomes,
filtering behaviour, or output schema requires a NEW version directory.
The full rules are in
[Architecture: Processors and Replay](../architecture/05-processors-and-replay.md)
under "Processor Versioning".

To introduce `v2` of a processor:

1. **Copy `v1/` to `v2/`** as the starting point. Do NOT edit `v1/`. Old
   versions stay around so historical replays remain reproducible.
2. **Bump `processor.manifest.yaml`** (`version: v2`, update `description`,
   `inputs`/`outputs`, `state_stores`, `replay.restrictions`).
3. **Make the code change** in `v2/src/`. Update `CHANGELOG.md` with a
   one-paragraph rationale.
4. **Add golden fixtures** under `v2/test/` so the contract is pinned.
5. **Activate `v2` per-project** via the CLI:

   ```bash
   ./polaris processors enable my-processor \
     --version v2 \
     --project storefront \
     --env development
   ```

6. **Disable `v1` when you are done** (intentional dual-write or hard cut
   is per-processor; the CLI itself is idempotent and writes audit rows
   for both directions):

   ```bash
   ./polaris processors disable my-processor \
     --version v1 \
     --project storefront \
     --env development
   ```

   `processors disable` does not accept a free-form reason in v1; the audit
   row records the actor and timestamp. `destinations disable` does require
   `--reason <text>` — see the [Audit and Export runbook](./audit-and-export.md)
   for the per-command audit shape.

Replay jobs (P7) consume the activation table directly so a replay against
`v1` continues to work after `v2` is active — no source-file gymnastics
required.

## Querying ClickHouse

ClickHouse has its own role model. Two roles ship in v1:

| Role              | Who uses it                                                                      | Can read                                                  | Can do DDL? |
| ----------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------- |
| `polaris_service` | Ingester, processors, consumers, future dashboard API, CLI inspection commands.  | Projection tables + `analytics_ingest_log` only.          | No          |
| `polaris_operator`| Replay/rebuild jobs, ad-hoc operator investigation, CLI operator commands.       | All of the above plus `analytics_raw`.                    | Yes         |

`pnpm clickhouse:bootstrap-local` creates both users locally with the
plaintext passwords `polaris_service` and `polaris_operator`. They are NOT
secrets — they exist so role-aware code paths work in development. See
[`infra/clickhouse/init/01_local_users.sql`](../../infra/clickhouse/init/01_local_users.sql).

The grants and role definitions themselves live in
[`sql/clickhouse/roles/`](../../sql/clickhouse/roles/) and are applied by
`pnpm clickhouse:migrate` in any environment.

### From `clickhouse-client`

```bash
# Inspect a projection table as the service role (safe; cannot reach raw).
clickhouse-client \
  --host 127.0.0.1 --port 9000 \
  --user polaris_service --password polaris_service \
  --query "SELECT * FROM polaris.event_daily_counts LIMIT 10"

# Same, as the operator role (broader access including analytics_raw).
clickhouse-client \
  --host 127.0.0.1 --port 9000 \
  --user polaris_operator --password polaris_operator \
  --query "SELECT count(DISTINCT event_id) FROM polaris.analytics_raw"
```

### From `shared-clickhouse` (the only sanctioned in-process path)

Services and CLI code never `import "@clickhouse/client"` directly — the
workspace-wide lint blocks it. Always go through
[`packages/shared-clickhouse`](../../packages/shared-clickhouse/), which
exposes a role-aware surface that mirrors the database grants.

```ts
import { createClickHouseClient } from "@polaris/shared-clickhouse";

// service profile: limited to projection tables + analytics_ingest_log.
const service = createClickHouseClient({
  url: "http://localhost:8123",
  role: "service",
  credential: { username: "polaris_service", password: "polaris_service" },
});

// projection table read; plain SELECT, no FINAL.
const rows = await service.projections.eventDailyCounts.read({
  projectId: "storefront",
  environment: "development",
  fromDate: "2026-05-01",
  limit: 10,
});

await service.close();
```

```ts
import { createClickHouseClient } from "@polaris/shared-clickhouse";

// operator profile: adds replay.* and the raw escape hatch.
const operator = createClickHouseClient({
  url: "http://localhost:8123",
  role: "operator",
  credential: { username: "polaris_operator", password: "polaris_operator" },
});

// dedupe-correct read against analytics_raw via argMax(col, _version).
const events = await operator.replay.argMaxByEventKey({
  projectId: "storefront",
  environment: "development",
  event: "checkout.started",
  eventIds: ["0193e0d3-...-001", "0193e0d3-...-002"],
});

await operator.close();
```

### Query patterns

`analytics_raw` is a `ReplacingMergeTree`. Between merges, duplicate rows
for the same `(project_id, environment, event, event_id)` coexist — plain
`SELECT *` returns them all and is wrong. The four canonical patterns,
in full, live in
[Architecture: ClickHouse / Query Patterns](../architecture/07-clickhouse.md#query-patterns).
The four-pattern summary:

| Pattern                                              | When to use                                                                                | Shape                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| **1. Materialized view → projection table**          | Production dedupe in motion; the MV is what writes deduped rows to projection tables.       | `argMax(col, _version) GROUP BY (project, env, event, event_id)` |
| **2. Plain SELECT on projection tables**             | Dashboards and APIs. Projection tables already store deduped rows.                          | `SELECT ... FROM <projection>`                     |
| **3. Ad-hoc operator query on `analytics_raw`**      | One-off operator investigation. Cluster-friendlier than the `FINAL` keyword.                | `SELECT ... FROM analytics_raw ... SETTINGS final = 1` |
| **4. Counting unique events**                        | Event counts and existence checks. Sidesteps merge state entirely.                          | `count(DISTINCT event_id) FROM analytics_raw`      |

Concrete examples, mirroring [`07-clickhouse.md`](../architecture/07-clickhouse.md#query-patterns):

```sql
-- Pattern 1: argMax(col, _version) — what the MVs use to feed projections.
SELECT
  project_id, environment, event, event_id,
  argMax(properties_json, _version) AS properties_json,
  argMax(occurred_at, _version)     AS occurred_at,
  argMax(source_id, _version)       AS source_id
FROM analytics_raw
GROUP BY project_id, environment, event, event_id;
```

```sql
-- Pattern 3: one-off operator query, SETTINGS final = 1 (NOT the FINAL keyword).
SELECT count() FROM analytics_raw
WHERE project_id = 'storefront' AND occurred_at >= now() - INTERVAL 1 DAY
SETTINGS final = 1;
```

```sql
-- Pattern 4: count distinct events — dedupe-safe by construction.
SELECT count(DISTINCT event_id) FROM analytics_raw
WHERE project_id = 'storefront' AND occurred_at >= now() - INTERVAL 1 DAY;
```

In application code, prefer the typed helper:

```ts
// Equivalent of Pattern 1, generated by the shared client.
const rows = await operator.replay.argMaxByEventKey({
  projectId: "storefront",
  environment: "development",
  event: "checkout.started",
  eventIds: [/* bounded list, max 5000 */],
});

// Equivalent of Pattern 4.
const distinct = await operator.replay.countDistinctEvents({
  projectId: "storefront",
  environment: "development",
  occurredFrom: "2026-05-01T00:00:00Z",
  occurredTo: "2026-05-13T00:00:00Z",
});
```

**Why service code cannot `SELECT * FROM analytics_raw`.** The grant simply
does not exist on the `polaris_service` role — the connection will be
refused at the database layer. The architecture rejected a regex SQL lint
(false positives on CTEs and dynamic SQL, false negatives on aliased
tables) in favour of grants + a workspace import rule. See
[Architecture: ClickHouse / Why grants instead of a lint](../architecture/07-clickhouse.md#why-grants-instead-of-a-lint).

**The escape hatch.** When you genuinely need an open-ended scan on
`analytics_raw` — replay backfill, schema exploration, an investigation
that cannot be expressed as a bounded `argMaxByEventKey` call — the operator
profile exposes `operator.raw.query(sql, params)`. Every call emits the
`ESCAPE_HATCH_METRIC` Prometheus counter and a structured log line, so
escape-hatch usage shows up in dashboards and audit trails. Use it
deliberately; it is intentionally observable. The full access policy is in
[Architecture: ClickHouse / Access Control](../architecture/07-clickhouse.md#access-control).

For a quick host-side smoke (no client setup), the `clickhouse:query`
helper script exposes a few canned commands:

```bash
pnpm clickhouse:query ping                  # /ping
pnpm clickhouse:query schema                # list polaris.* tables and roles
pnpm clickhouse:query ingest-log --limit 20 # recent analytics_ingest_log rows
pnpm clickhouse:query raw-count             # count(DISTINCT event_id) on analytics_raw
pnpm clickhouse:query event-daily-counts    # rows from the example projection table
```

It uses host fetch and bypasses the typed client, so it is fine for smoke
checks but is NOT a substitute for `shared-clickhouse` in application code.

## Troubleshooting

| Symptom                                                                    | Likely cause                                                                                                            | Fix                                                                                                                       |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `docker compose up` hangs or fails immediately                             | Docker daemon is not running.                                                                                            | Start Docker Desktop / `colima start` / `systemctl start docker` and retry.                                                |
| `Error: bind: address already in use` on `docker compose up`               | Another service is listening on `5432`, `6379`, `8123`, `9000`, or `19092`.                                              | Stop the other service, or set the matching `*_HOST_PORT` env var to a free port and recreate the container.              |
| `pnpm install` fails with `ERR_PNPM_UNSUPPORTED_ENGINE`                    | Wrong Node or pnpm version.                                                                                              | `nvm use 22` and `corepack prepare pnpm@10.30.0 --activate`. The pinned versions are in `package.json`.                    |
| `pnpm-lock.yaml has changed` in CI but not locally                          | Lockfile drift — a dependency was added without committing the regenerated lockfile.                                     | `pnpm install` and commit `pnpm-lock.yaml`.                                                                                |
| `dbmate: command not found`                                                | `pnpm install` did not link the `dbmate` binary, or you are running outside the workspace.                                | Run `pnpm install`, or call dbmate directly via `pnpm --filter @polaris/shared-db exec dbmate ...`.                        |
| `pnpm db:migrate` reports `connection refused`                              | PostgreSQL container is not up, or `DATABASE_URL` points elsewhere.                                                       | `docker compose ps postgres` should show "healthy"; default `DATABASE_URL` is `postgres://polaris:polaris@localhost:5432/polaris?sslmode=disable`. |
| `pnpm clickhouse:bootstrap-local` fails with `Cannot find module`            | The script ships as `.mjs` but Node 22 still needs the workspace install first.                                           | Run `pnpm install` from the repo root.                                                                                     |
| `pnpm lint` fails with `disallowed import "@clickhouse/client"`             | A file outside `packages/shared-clickhouse/` imported the official client.                                                | Route the access through `@polaris/shared-clickhouse` instead. See [CI / ClickHouse import-restriction check](./ci.md#clickhouse-import-restriction-check). |
| `pnpm typecheck` succeeds but `pnpm test` fails with "Cannot find module"  | Stale `dist/` from a partial build, or a workspace package referenced before its `build` ran.                            | `pnpm build && pnpm test`. The CI `test` job also runs `pnpm build` first for this reason.                                  |
| `pnpm openapi:check` fails after a Zod schema edit                          | The committed OpenAPI document drifted from the Zod sources.                                                              | `pnpm openapi` and commit the regenerated `docs/api/openapi.{yaml,json}`. See [API docs](../api/README.md).                |
| `pnpm smoke:vertical-slice` reports `ECONNREFUSED` on `http://localhost:8080/v1/events` | The ingester is not running, or it bound to port `3000` (the platform default).                                          | Restart with `POLARIS_HTTP_PORT=8080 pnpm --filter @polaris/ingester-api run start`, or export `POLARIS_INGESTER_URL`.       |
| `psql: command not found` during the smoke seed step                       | The smoke shells out to `psql` to mint an API key.                                                                        | `brew install postgresql` / `apt-get install postgresql-client`, or export `POLARIS_SMOKE_API_KEY` directly to skip the seed. |

The vertical-slice smoke runbook has its own failure-mode matrix scoped to
end-to-end runs; see
[Vertical-Slice Smoke / Common failure modes](../implementation/runbooks/vertical-slice-smoke.md#common-failure-modes).

## Reset and cleanup

```bash
docker compose down                     # stop containers, KEEP named volumes
docker compose down -v                  # stop AND wipe volumes (destructive)
# or:
make down
make nuke                               # same as `down -v`

# Wipe smoke-minted API keys (they linger under the polaris_ak_smoke_ prefix).
psql "$DATABASE_URL" -c "DELETE FROM api_keys WHERE api_key_id LIKE 'polaris_ak_smoke_%';"

# Remove built artefacts across the workspace (per-package `clean` scripts).
pnpm clean
```

After `make nuke` you'll need the full first-time setup sequence again:
`pnpm install` is still good, but `docker compose up -d --wait`,
`pnpm db:migrate`, and `pnpm clickhouse:bootstrap-local` all start from
zero state.

## Where to look next

- [SDK Handbook](../sdk/README.md) — installing, configuring, and operating
  the Web and Node SDKs against a Polaris ingester.
- [API Docs](../api/README.md) — published OpenAPI document for the
  ingester, plus local rendering instructions.
- [CI](./ci.md) — required PR gates, the ClickHouse import-restriction check,
  how to opt into integration runs.
- [Audit and Export](./audit-and-export.md) — `polaris audit list/show` and
  `polaris export ...` workflows.
- [Vertical-Slice Smoke](../implementation/runbooks/vertical-slice-smoke.md) —
  the full end-to-end test (Docker-gated) plus CI integration.
- Architecture deep-dives (read these when you need to change behaviour
  in the matching layer):
  - [01 Event Contract](../architecture/01-event-contract.md) — envelope,
    `schema_version`, forbidden-field policy.
  - [02 Control Plane](../architecture/02-control-plane.md) — projects,
    sources, API keys, runtime/control state.
  - [03 RabbitMQ Streams](../architecture/03-rabbitmq-streams.md) —
    `raw.events`, derived topics, partition discipline.
  - [04 Ingestion and SDKs](../architecture/04-ingestion-and-sdks.md) —
    what the ingester does and does not do.
  - [05 Processors and Replay](../architecture/05-processors-and-replay.md) —
    versioning, immutability, replay flow.
  - [07 ClickHouse](../architecture/07-clickhouse.md) — engine families,
    query patterns, access control.
  - [08 Observability and Operations](../architecture/08-observability-and-operations.md) —
    logs, metrics, health/readiness, OpenTelemetry hooks.
  - [09 Engineering Standards](../architecture/09-engineering-standards.md) —
    TypeScript, Vitest, OpenAPI, error contract.
