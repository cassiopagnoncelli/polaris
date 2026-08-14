# Vertical-Slice Smoke Test (P5-001)

The vertical-slice smoke proves the canonical Polaris event path end-to-end:

```text
curl POST /v1/events
  -> apps/ingester-api
  -> RabbitMQ raw.events
  -> sync/legacy/analytics-projector/v1
  -> RabbitMQ analytics.events
  -> clickhouse-sink (analytics_events_queue)
  -> analytics_raw
```

The test is a black-box exercise. It talks to the ingester over HTTP and
asserts the row by querying ClickHouse. No AMQP client / Redis / PostgreSQL
introspection at the topic level — the whole point is to prove the real
wire.

## When to run it

- Locally, before merging changes that touch any of: ingester, SDK
  envelope shape, the analytics-projector v1, ClickHouse DDL, or the
  RabbitMQ topic resolver.
- In CI, automatically on label `integration`, scheduled at 06:00 UTC,
  or on demand via the Actions UI (Workflow: **Integration**).

## Prerequisites

- Docker daemon running.
- pnpm 10.x and Node 22.
- A fresh checkout. The smoke runner uses the same `docker-compose.yml`
  the local-dev stack uses.

## One-shot local run

```bash
# 1. install + bring up the local stack
pnpm install
docker compose up -d --wait

# 2. apply migrations
pnpm db:migrate
pnpm clickhouse:bootstrap-local

# 3. start the ingester and the analytics-projector in two terminals,
#    or background them. The smoke runner expects:
#      - the ingester on http://localhost:4000
#      - the analytics-projector connected to rabbitmq:9092 (compose
#        internal hostname) — already the default.
pnpm --filter @polaris/ingester-api run start &
pnpm --filter @polaris/processor-analytics-projector-v1 run start &

# 4. run the smoke
pnpm smoke:vertical-slice
```

Expected output (abridged):

```text
[polaris-smoke] start
[polaris-smoke] ingester=http://localhost:4000
[polaris-smoke] clickhouse=http://localhost:8123
[polaris-smoke] project=storefront env=development source=payments-api
[polaris-smoke] step=seed mode=mint database=set
[polaris-smoke] step=seed api_key_id=polaris_ak_smoke_018...
[polaris-smoke] step=send event_id=<uuid> event=checkout.started
[polaris-smoke] step=send result=accepted status=200
[polaris-smoke] step=poll target=analytics_raw event_id=<uuid> timeout_ms=60000
[polaris-smoke] step=verify row=event_id=<uuid> event=checkout.started ...
[polaris-smoke] result=pass
```

A pass means:

1. The ingester accepted the event and per-event response carried `status: "accepted"`.
2. RabbitMQ durably accepted the message on `raw.events`.
3. The analytics-projector v1 consumed it and emitted to `analytics.events`.
4. ClickHouse's ingestion interface table read the message into `analytics_ingest_log`
   and the MV propagated it into `analytics_raw`.
5. The row carries the expected envelope fields plus
   `processor_name='analytics-projector'`, `processor_version='v1'`.

## Vitest wrapper

The same runner is wired into Vitest at
[`tests/smoke/vertical-slice.test.ts`](../../../tests/smoke/vertical-slice.test.ts).
The wrapper skips unless `POLARIS_SMOKE_DOCKER=1` is set, so the default
`pnpm test` stays Docker-free.

```bash
# Same orchestration as above, then:
POLARIS_SMOKE_DOCKER=1 pnpm test:smoke
```

## Environment variables

| Variable                            | Default                                            | Purpose                                                                       |
| ----------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------- |
| `POLARIS_INGESTER_URL`              | `http://localhost:4000`                            | Where the smoke posts the event.                                              |
| `POLARIS_SMOKE_API_KEY`             | _(unset)_                                          | When set, bypasses seeding; the runner uses this token verbatim.              |
| `POLARIS_SMOKE_PROJECT_ID`          | `storefront`                                       | Stamped into the envelope and the seeded API key.                             |
| `POLARIS_SMOKE_ENVIRONMENT`         | `development`                                      | Stamped into the envelope and the seeded API key.                             |
| `POLARIS_SMOKE_SOURCE_ID`           | `payments-api`                                     | Stamped into the envelope and the seeded API key.                             |
| `POLARIS_SMOKE_SOURCE_TYPE`         | `backend`                                          | Stamped into the envelope and the seeded API key.                             |
| `POLARIS_SMOKE_POLL_TIMEOUT_MS`     | `60000`                                            | Maximum wall-clock wait for ClickHouse to observe the event.                  |
| `POLARIS_SMOKE_POLL_INTERVAL_MS`    | `1000`                                             | Polling interval between ClickHouse checks.                                   |
| `DATABASE_URL`                      | _(required when seeding)_                          | PostgreSQL connection string used for the `psql` seed shell-out.              |
| `CLICKHOUSE_URL`                    | `http://localhost:8123`                            | HTTP base URL for the ClickHouse query helper.                                |
| `CLICKHOUSE_USER`                   | `polaris`                                          | ClickHouse user. Falls back to the admin user from `docker-compose.yml`.      |
| `CLICKHOUSE_PASSWORD`               | `polaris`                                          | ClickHouse password.                                                          |
| `POLARIS_SMOKE_DOCKER`              | _(unset)_                                          | When `1`, the Vitest wrapper at `tests/smoke/` runs the smoke.                |

## Seeding semantics

Without `POLARIS_SMOKE_API_KEY`, the runner mints an API key by:

1. Ensuring `projects` and `sources` rows exist via `INSERT ... ON CONFLICT
   DO NOTHING`.
2. Generating a `polaris_ak_smoke_<uuidv7>` id with a fresh 32-byte
   base64url secret tail.
3. Hashing the secret through `@polaris/shared-secrets` so the resulting
   row is byte-compatible with what `polaris keys create` would produce.
4. Inserting an `active` row.

API keys minted by the smoke linger in `api_keys`. The `polaris_ak_smoke_`
prefix makes them easy to prune:

```sql
DELETE FROM api_keys WHERE api_key_id LIKE 'polaris_ak_smoke_%';
```

If you want to use a pre-existing key (for example the one issued by
`polaris keys create` during onboarding), export it and the seed step
becomes a no-op:

```bash
export POLARIS_SMOKE_API_KEY='polaris_ak_<uuidv7>.<base64url-secret>'
pnpm smoke:vertical-slice
```

## Common failure modes

| Symptom                                                              | Likely cause                                                                            | Fix                                                                                                                  |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `failed to POST http://localhost:4000/v1/events: ... ECONNREFUSED`   | The ingester is not running.                                                            | `pnpm --filter @polaris/ingester-api run start` and retry.                                                            |
| `ingester did not accept the event: ... http_error 401`              | The API key is invalid or the seed step did not run.                                    | Check `pg_hba.conf` / DATABASE_URL, or export `POLARIS_SMOKE_API_KEY` directly.                                       |
| `timed out after 60000ms waiting for analytics_raw`                  | The analytics-projector is not running, ClickHouse is not consuming, or the MV is down. | `docker compose logs analytics-projector clickhouse`. Bump `POLARIS_SMOKE_POLL_TIMEOUT_MS` for slow CI runners.       |
| `psql: command not found`                                            | The seed step shells out to `psql`.                                                     | Install postgresql-client (`brew install postgresql` / `apt-get install postgresql-client`), or pass `POLARIS_SMOKE_API_KEY`. |
| `@polaris/shared-secrets is not available`                           | The smoke runner ran from a tree without `pnpm install`.                                | Run `pnpm install` from the repo root, or pass `POLARIS_SMOKE_API_KEY`.                                               |
| `ClickHouse 500 ... Cannot resolve host: rabbitmq`                   | ClickHouse is running outside the compose network and cannot reach RabbitMQ.            | Use `docker compose up -d` (which the smoke expects), not standalone `docker run` for ClickHouse.                     |

## CI integration

The smoke runs in `.github/workflows/integration.yml` under the
`vertical-slice-smoke` job. The workflow:

1. Brings up the local stack with `docker compose up -d --wait`.
2. Applies PostgreSQL migrations and the ClickHouse schema (including the
   local user bootstrap).
3. Starts the ingester and analytics-projector as background processes.
4. Runs `pnpm smoke:vertical-slice` and `pnpm test:smoke`.
5. Dumps service logs on failure and tears the stack down.

Trigger the workflow:

- **Schedule:** runs at 06:00 UTC daily.
- **Label:** apply `integration` to a PR.
- **Manual:** from the Actions UI, pick **Integration** > **Run workflow**.

## Known gaps

- **SDK-driven variant.** v1 of the smoke uses a hand-crafted POST to
  exercise the ingester wire path. An SDK-driven variant that also
  exercises the `@polaris/node-sdk` queue / retry / flush path is honest
  future work — when added, it will live next to this file and share the
  same seeding + ClickHouse polling helpers.
- **Cross-version replay.** The smoke only verifies the fresh-write path.
  Replay-driven `_version` collisions and ReplacingMergeTree merges are
  covered by the P7-* replay system tasks.
- **Local execution under sandboxed agents.** Agent-driven smoke runs
  inside a CI runner that lacks a Docker daemon are deferred. The script
  is parse- and unit-tested under `pnpm typecheck` / `pnpm test:scripts`
  so the artifact remains verifiable in those environments; a live
  exercise still requires Docker.
