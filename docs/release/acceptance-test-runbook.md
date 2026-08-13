# Product Acceptance Test Runbook

This runbook is the **release gate** an internal team runs to answer one
question: _is Polaris usable end-to-end for one internal project?_

It exercises every link in the canonical event path on a real local or
staging stack and either prints a green PASS table or stops at the first
red row. It is **not** a unit test in disguise — every step talks to a
production-shipped surface (the `polaris` CLI binary, the published
`@polaris/node-sdk`, real HTTP against the ingester, real ClickHouse
queries, real `polaris deliveries list`, real `polaris replay` flow).

The acceptance test is the canonical signal that the change set on
`main` is shippable to an internal team. Treat a failure as a blocker;
file the issue, link to this runbook, and look at the failure modes
section below.

## What the test asserts

Each numbered step is a separate assertion block in the Vitest report.

| Step | What it proves |
| --- | --- |
| 1. `control_plane_catalog` | `polaris projects sync` + `polaris sources sync` can materialise the YAML catalog into PostgreSQL. |
| 2. `control_plane_project_config` | `polaris config set` / `list` / `validate` / `unset` round-trip a per-`(project, environment)` value through the audited write path — the loop an operator uses to change a project's configuration without a redeploy. |
| 3. `control_plane_api_key` | `polaris keys create` mints a fresh backend API key bound to one `(project, env, source)` tuple. |
| 4. `control_plane_destination` | `polaris destinations create` + `polaris destinations enable` register and activate a webhook-sink instance. |
| 5. `sdk_track` | The published `@polaris/node-sdk` enqueues a `checkout.started` v1 event, flushes it, and the ingester returns per-event `accepted`. |
| 6. `ingestion_accepted` | The acceptance signal observed by step 5 is preserved end-to-end. |
| 7. `analytics_persisted` | `analytics-projector` v1 consumed the event and ClickHouse `analytics_raw` exposes the row with `processor_name='analytics-projector'`, `processor_version='v1'`. |
| 8. `delivery_observed` | A `delivery_records` row exists for the event on the webhook-sink destination (visible via `polaris deliveries list`). |
| 9. `replay_dry_run` | `polaris replay create --mode dry_run` records the operator intent and `polaris replay plan` renders the deterministic plan with no DB writes. |
| 10. `release_documentation` | The acceptance runbook itself plus the four cross-referenced operations runbooks exist and are non-empty. |

A **pass** means every step is `pass` or `skip` (skips are explicit
opt-outs documented below). A **fail** means at least one step reported
`fail` — the failure appears in-line in the Vitest report and below
the per-step table the runner prints.

## Prerequisites

| Requirement | Why |
| --- | --- |
| `docker compose up -d --wait` against the repo root compose file | Brings up RabbitMQ, PostgreSQL, Redis, ClickHouse. The acceptance test posts to a real ingester at `http://localhost:4000` by default. |
| `pnpm install` | Workspace dependencies. |
| `pnpm -r build` | The acceptance scenario shells out to the compiled `polaris` CLI binary at `apps/polaris-cli/dist/bin/polaris.js` and imports `@polaris/node-sdk` by name. Both surfaces must be built. |
| `pnpm db:migrate` | PostgreSQL migrations at HEAD — control-plane tables (`projects`, `sources`, `api_keys`, `destinations`, `delivery_records`, `replay_jobs`, `audit_records`) must exist. |
| `pnpm clickhouse:bootstrap-local` + `pnpm clickhouse:migrate` | ClickHouse schema at HEAD — `polaris.analytics_raw` must exist with the v1 columns. |
| Ingester running | `pnpm --filter @polaris/ingester-api run start` in a background terminal (or via your usual local dev orchestration). |
| `analytics-projector` running | `pnpm --filter @polaris/processor-analytics-projector-v1 run start` in a background terminal. |
| Optional: webhook-sink running | Only required for step 4 + step 8. When omitted, set `POLARIS_ACCEPTANCE_SKIP_DESTINATION=1` and those steps are skipped (overall verdict still PASS). |
| Optional: `psql` on `$PATH` | Some downstream investigation tooling shells out to `psql`. The scenario itself does not require it. |

## Running it

The supported entry point is the wrapped script, **not** raw Vitest:

```bash
pnpm test:acceptance
```

This:

1. Verifies the CLI binary, the runbook, and `DATABASE_URL` are present.
2. Sets `POLARIS_ACCEPTANCE_TEST=1` (the gating env var that flips the
   Vitest scenario from "skipped" to "live"). Without this var,
   `pnpm test` and `pnpm test:smoke` still ignore the scenario.
3. Runs `vitest run tests/acceptance/scenarios/full-pipeline.test.ts`
   so the operator sees the canonical Vitest reporter output.
4. Exits non-zero on any step failure.

To exercise the scenario library directly without Vitest (useful when
debugging a single step) you can call the underlying runner — but the
supported gate is `pnpm test:acceptance`.

## Environment variables

The acceptance scenario inherits the vertical-slice smoke's variables
where they overlap, plus a few of its own.

| Variable | Default | Purpose |
| --- | --- | --- |
| `POLARIS_ACCEPTANCE_TEST` | _(unset)_ | Set by `pnpm test:acceptance`. When `1`, the Vitest scenario runs; otherwise it skips. |
| `POLARIS_INGESTER_URL` | `http://localhost:4000` | Where the Node SDK posts the event. |
| `POLARIS_ACCEPTANCE_PROJECT_ID` | `storefront` | Project under test. Must exist in `catalog/projects/`. |
| `POLARIS_ACCEPTANCE_ENVIRONMENT` | `development` | Environment string stamped onto the API key, destination, and replay job. |
| `POLARIS_ACCEPTANCE_SOURCE_ID` | `payments-api` | Source under test. Must exist in `catalog/sources/<project>/`. |
| `POLARIS_ACCEPTANCE_SOURCE_TYPE` | `backend` | Source type the API key authenticates. |
| `POLARIS_ACCEPTANCE_VENDOR` | `webhook` | Destination vendor. Only `webhook` is supported in this test because it is the only consumer that does not require a vendor sandbox. |
| `POLARIS_ACCEPTANCE_INSTANCE_LABEL` | `acceptance-sink` | Stable label for the test destination. Idempotent on re-runs. |
| `POLARIS_ACCEPTANCE_WEBHOOK_URL` | _(empty)_ | Receiver URL for the webhook-sink. When empty the destination step is **skipped** and the delivery-observation step skips with it. |
| `POLARIS_ACCEPTANCE_SKIP_DESTINATION` | `0` | Explicit override to skip steps 3 + 7 regardless of `POLARIS_ACCEPTANCE_WEBHOOK_URL`. |
| `POLARIS_ACCEPTANCE_POLL_TIMEOUT_MS` | `60000` | Max wall-clock wait for ClickHouse / deliveries observation per step. |
| `POLARIS_ACCEPTANCE_POLL_INTERVAL_MS` | `1000` | Polling interval. |
| `DATABASE_URL` | _(required)_ | PostgreSQL connection string used by the `polaris` CLI. The runner pre-flights this. |
| `CLICKHOUSE_URL` | `http://localhost:8123` | ClickHouse HTTP base URL. |
| `CLICKHOUSE_USER` | `polaris` | ClickHouse user. |
| `CLICKHOUSE_PASSWORD` | `polaris` | ClickHouse password. |

## Sample passing output

Abridged — the actual run prints the full Vitest reporter as well.

```text
==============================================================================
                        Polaris Product Acceptance Test
                          v0.0.0 -- release-gate run
==============================================================================

  This run drives the canonical happy path end-to-end through real
  services. ...

  Scenario      : tests/acceptance/scenarios/full-pipeline.test.ts
  Ingester      : http://localhost:4000
  Project / env : storefront / development
==============================================================================

 RUN  v4.1.6 /Users/.../polaris

 PASS  tests/acceptance/scenarios/full-pipeline.test.ts > product acceptance (full pipeline)
   PASS  ran every step in the expected order
   PASS  step "control_plane_catalog" passes (or skips cleanly)
   PASS  step "control_plane_api_key" passes (or skips cleanly)
   PASS  step "control_plane_destination" passes (or skips cleanly)
   PASS  step "sdk_track" passes (or skips cleanly)
   PASS  step "ingestion_accepted" passes (or skips cleanly)
   PASS  step "analytics_persisted" passes (or skips cleanly)
   PASS  step "delivery_observed" passes (or skips cleanly)
   PASS  step "replay_dry_run" passes (or skips cleanly)
   PASS  step "release_documentation" passes (or skips cleanly)
   PASS  emits a verdict of pass

==============================================================================
                          Acceptance verdict: PASS
==============================================================================
```

## Failure modes

| Step | Likely cause | Where to look |
| --- | --- | --- |
| `control_plane_catalog` | `DATABASE_URL` wrong, PostgreSQL not up, migrations not applied | `docker compose ps postgres`, `pnpm db:status`, [docs/development/getting-started.md](../development/getting-started.md) |
| `control_plane_project_config` | `project_config` migrations not applied, or the CLI cannot reach PostgreSQL | `pnpm db:status`; the step writes through the same path as `polaris config set`, so try that command by hand |
| `control_plane_api_key` | API key INSERT collides with a stale row from a previous failed run | `psql -c "DELETE FROM api_keys WHERE source_id='payments-api' AND environment='development'"` (the test does not auto-clean to preserve a forensic trail) |
| `control_plane_destination` | Webhook URL empty, vendor mismatch, secret-ref validation failed | Either set `POLARIS_ACCEPTANCE_WEBHOOK_URL` or set `POLARIS_ACCEPTANCE_SKIP_DESTINATION=1` to skip the destination steps |
| `sdk_track` | Ingester not running, API key never propagated, SDK queue/transport regression | `docker compose logs ingester-api`, `curl http://localhost:4000/health`, check the SDK's `onDrop` diagnostic in the scenario output |
| `analytics_persisted` | `analytics-projector` not running, ClickHouse not consuming, ReplacingMergeTree merge race | [docs/implementation/runbooks/vertical-slice-smoke.md](../implementation/runbooks/vertical-slice-smoke.md) "Common failure modes" — same triage as the smoke |
| `delivery_observed` | webhook-sink consumer not running, destination disabled, destination filter dropping the event | [docs/operations/destination-dlq-triage.md](../operations/destination-dlq-triage.md) walks the DLQ triage flow |
| `replay_dry_run` | `replay_jobs` migration missing, replay planner regression | `pnpm db:status`, [docs/architecture/05-processors-and-replay.md](../architecture/05-processors-and-replay.md) "Replay Control Plane" |
| `release_documentation` | A referenced runbook was deleted or truncated | The error names the missing file; restore it or update the scenario's expected doc list |

For platform-level issues touching multiple steps:

- **DLQ pile-up** — [docs/operations/destination-dlq-triage.md](../operations/destination-dlq-triage.md).
- **Backup / retention drift** — [docs/operations/backup-and-retention.md](../operations/backup-and-retention.md).
- **Topic-isolation cutover** — [docs/operations/topic-isolation-cutover.md](../operations/topic-isolation-cutover.md).
- **Local observability stack** — [docs/development/observability.md](../development/observability.md).
- **Vertical-slice smoke (single-event path)** — [docs/implementation/runbooks/vertical-slice-smoke.md](../implementation/runbooks/vertical-slice-smoke.md).

The acceptance test extends the smoke; it does not replace it. When
both fail, fix the smoke first — the surface it covers (one event
through the ingester to ClickHouse) is a strict subset of step 5 +
step 7 here.

## Release gate posture

- The acceptance test is **the** signal a release is shippable.
- A `pnpm test:acceptance` run is required before tagging a release
  candidate (P12-005). The release checklist links here.
- Failures are blockers. Do not waive a step without a documented
  reason on the release ticket.
- Skips are not failures, but every skip must be deliberate and
  documented in the release notes (e.g. "no webhook receiver in the
  staging environment, destination steps intentionally skipped").

## What the test does NOT assert

- It does not run a vendor-specific destination consumer against a
  live external sandbox. Meta CAPI, GA4, TikTok, and Braze are out of
  scope. The webhook-sink covers the delivery surface end-to-end
  because it is the only consumer that does not require a vendor
  sandbox.
- It does not validate dashboards render — only that the
  observability documentation exists. Dashboard rendering is owned by
  P10-003.
- It is not a chaos test. It does not simulate network partitions,
  ClickHouse failover, or partial outages.
- It is not a load test. It sends one event. Load and capacity
  signoff are owned by P10 / P11.
- Replay runs in `dry_run` mode only. Live replay execution is out of
  scope for the acceptance gate.

These are the right boundaries for a release gate. Pushing them
further turns the gate into an integration suite and dilutes its
"shippable?" signal.
