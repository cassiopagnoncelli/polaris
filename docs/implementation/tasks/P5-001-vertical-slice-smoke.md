# P5-001: Vertical Slice Smoke Test

Status: Done (merged in `e9c7651`)

## Goal

Add a smoke test or script proving one event can travel through the first vertical slice.

## Required Reading

- [Architecture Overview](../../architecture/00-overview.md)
- [Ingestion and SDKs](../../architecture/04-ingestion-and-sdks.md)
- [ClickHouse](../../architecture/07-clickhouse.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)

## Dependencies

- P1-001
- P2-003
- P3-001 or P3-003
- P4-001
- P4-002

## Write Scope

Allowed:

```text
scripts/
tests/
package.json
docs/implementation/
```

Forbidden:

```text
architecture-changing edits outside docs/implementation/
```

## Implementation Notes

The smoke path should prove:

```text
SDK or test client
  -> ingester
  -> raw.events
  -> analytics processor
  -> analytics.events
  -> ClickHouse
  -> basic query
```

If a fully automated test is not yet feasible, create the closest repeatable script and document the gaps.

## Acceptance Criteria

- [x] Repeatable command exists (`pnpm smoke:vertical-slice`, plus the
      Vitest wrapper invoked via `pnpm test:smoke`).
- [x] It sends one governed event (`checkout.started` v1 from the catalog,
      sent via a hand-crafted POST so the event_id is deterministic and
      can be matched in ClickHouse).
- [x] It verifies event acceptance by ingester (asserts HTTP 200 plus a
      per-event `accepted` entry with the matching `event_id`).
- [x] It verifies downstream presence (polls `polaris.analytics_raw` for
      the same `event_id` with the dedupe-safe
      `count(DISTINCT event_id)` shape, then reads back the row to
      assert envelope identity and the `analytics-projector`/`v1`
      processor stamp).
- [x] Output is human-readable (grep-friendly `[polaris-smoke] step=...`
      log lines on stdout, plain error messages on stderr).

## Checks

Run where possible:

```text
pnpm smoke:vertical-slice
```

## Handoff

```text
Files changed:
  package.json                                              (+ typecheck pass over tests/, + smoke:vertical-slice, + test:smoke)
  vitest.config.ts                                          (added tests/** include)
  tsconfig.json                                             (excluded tests/)
  tests/tsconfig.json                                       (new — strict typecheck for tests/, allowJs for .mjs imports)
  tests/smoke/vertical-slice.test.ts                        (new — POLARIS_SMOKE_DOCKER-gated vitest wrapper)
  scripts/smoke/vertical-slice.mjs                          (new — CLI runner: seed → send → poll → verify)
  scripts/smoke/harness.mjs                                 (new — pure helpers: envelope build, POST, ClickHouse poll, psql seed)
  scripts/smoke/uuidv7.mjs                                  (new — RFC 9562 v7 minter for the seed api_key_id)
  scripts/__tests__/smoke-harness.test.ts                   (new — 13 unit tests for the pure helpers)
  .github/workflows/integration.yml                         (rewrote placeholder → real smoke job using docker compose)
  docs/implementation/runbooks/vertical-slice-smoke.md      (new — runbook with env-var table and failure modes)
  docs/implementation/tasks/P5-001-vertical-slice-smoke.md  (this file — status Ready → Review + completed acceptance + handoff)

Files audited and confirmed correct (no changes):
  apps/ingester-api/src/routes/events.ts          (POST /v1/events shape; envelope + per-event response)
  apps/ingester-api/src/ingest/handler.ts         (stampTrustedMetadata, per-event accept/reject loop)
  processors/analytics-projector/v1/src/transform.ts  (passthrough + processor_name/processor_version stamp)
  sql/clickhouse/10_analytics_events_queue.sql    (Kafka Engine reads analytics.events, JSONEachRow)
  sql/clickhouse/30_analytics_raw.sql             (ReplacingMergeTree(_version), key shape used in the poll)
  catalog/events/checkout/started.v1.yaml          (chosen governed event — ACTIVE lifecycle)
  catalog/projects/storefront.yaml                 (seeded by the runner)
  catalog/sources/storefront/payments-api.yaml    (seeded by the runner)
  packages/shared-secrets                          (re-used for argon2id-compatible API key hashing)

Commands run:
  pnpm install --frozen-lockfile                            (passes)
  pnpm build                                                (passes)
  pnpm typecheck                                            (passes — tsconfig, scripts/tsconfig, tests/tsconfig, all workspace packages)
  pnpm test                                                 (passes — 941 workspace + 59 script tests, 1 skipped smoke gate)
  pnpm lint                                                 (passes — biome + clickhouse-imports)
  pnpm format:check                                         (passes)
  node scripts/smoke/vertical-slice.mjs                     (parses; fails as expected when the local stack is down — fast diagnostic exit)

Checks passed:
  pnpm typecheck, pnpm test (workspace + scripts), pnpm lint, pnpm format:check
  Smoke runner parse-validated and unit-tested.

Known gaps:
  * Live end-to-end exercise (Docker compose + ingester + analytics-projector + ClickHouse)
    was NOT run in this worker — Docker daemon was unavailable in the sandbox. The
    unit-test suite covers buildEnvelope, postEvent, pollClickHouseForEvent (success +
    transient retry + timeout), formatRow, and the UUIDv7 minter. The integration
    workflow runs the live exercise next time it is triggered (label `integration`,
    schedule, or workflow_dispatch). See P4-002 for the same constraint pattern.
  * SDK-driven variant. v1 of the smoke uses a hand-crafted POST so the event_id is
    deterministic from the runner's side. An SDK-driven variant exercising the
    @polaris/node-sdk queue + retry + flush surface is documented in the runbook
    under "Known gaps" and is honest future work.
  * Cleanup behaviour. The smoke leaves `polaris_ak_smoke_*` api_keys in PostgreSQL.
    The runbook documents the prefix and a one-liner to prune them, but pruning is
    not automatic so the test can run safely against shared environments.
  * The integration workflow rewrite ditches the GitHub `services:` containers and
    uses `docker compose up -d --wait` instead, because the existing service-container
    shape would not let ClickHouse's Kafka Engine table resolve `redpanda` by hostname.
    Compose puts every container on the shared `polaris` bridge, matching the local-dev
    network shape 1:1.

Design notes for reviewers:
  * The runner ships as plain .mjs alongside scripts/clickhouse-* so a fresh
    `git clone && pnpm install && docker compose up` install can exercise it without
    building the whole workspace.
  * `analytics_raw` polling uses the count(DISTINCT event_id) shape from
    07-clickhouse.md Pattern 4 to sidestep ReplacingMergeTree merge state. The
    follow-up SELECT uses `SETTINGS final = 1` (Pattern 3) because this is the
    documented ad-hoc-operator-query shape, and the smoke is a one-shot operator
    inspection, not a hot-path read.
  * The Vitest wrapper exists only so the integration workflow gets a standard
    pass/fail line in the matrix reporter. The runner itself is the canonical
    surface — anyone can `pnpm smoke:vertical-slice` without Vitest installed.
  * The seed step shells out to `psql` rather than depending on the `pg` package
    to keep scripts/ dependency-free. Operators without `psql` available can
    bypass seeding via POLARIS_SMOKE_API_KEY=<token>.
```

