# P0-010: Shared ClickHouse Client Package

Status: Backlog

## Goal

Create the workspace package that owns all ClickHouse access for services and the CLI. The package's typed read methods are the only sanctioned path against `analytics_raw`-derived data; ad-hoc direct queries route through a separate operator workflow.

## Required Reading

- [ClickHouse / Query Patterns](../../architecture/07-clickhouse.md)
- [ClickHouse / Access Control](../../architecture/07-clickhouse.md)
- [Engineering Standards / ClickHouse Access](../../architecture/09-engineering-standards.md)
- [Claude Instructions](../../instructions/claude.md)

## Dependencies

- P0-001
- P0-002
- P0-003

## Write Scope

Allowed:

```text
packages/shared-clickhouse/
package.json
pnpm-workspace.yaml
```

Forbidden:

```text
apps/
processors/
consumers/
sql/
infra/
```

## Implementation Notes

### Package shape

```text
packages/shared-clickhouse/
  src/
    client.ts          connection setup, pool, lifecycle
    config.ts          Zod-validated client config (URL, role, credentials ref)
    projections/       typed reads against projection tables (added as projections come online)
    ingest-log.ts      typed inspection of analytics_ingest_log
    replay.ts          argMax-based reads against analytics_raw (operator-role only)
    health.ts          health/readiness helpers
    errors.ts          typed error classes for connection, query, role denial
  test/
```

- Wrap the official `@clickhouse/client` package. Do not write a custom protocol layer.
- All methods return typed results validated against shared schemas where the result shape is stable.
- The package is the only place in the workspace that imports `@clickhouse/client`. A workspace-level rule (Biome `noRestrictedImports` or equivalent) blocks direct imports elsewhere.

### Role-aware connection

The package exposes two connection profiles, chosen at config time:

```text
service     SELECT on projection tables + analytics_ingest_log only
operator    broader access including analytics_raw and DDL
```

Services and the CLI's routine inspection paths use the `service` profile. Replay/rebuild jobs and operator-issued investigation commands use the `operator` profile. The package refuses to construct a connection if the role is not declared.

### What the package exposes

Service profile (read-only, safe surface):

- `client.projections.<name>.read(filter, range)` — typed access per projection table; methods grow as projections land
- `client.ingestLog.inspect(filter)` — read the ingest log
- `client.health.check()`

Operator profile (additional methods):

- `client.replay.argMaxByEventKey({ project_id, environment, event, eventIds })` — typed argMax-based read against `analytics_raw`
- `client.replay.countDistinctEvents(filter)` — distinct-event count with documented cost
- `client.operator.raw.query(sql, params)` — escape hatch for genuinely-ad-hoc operator SQL. Emits a metric and a structured log line on every call; reviewers can see who used it and why.

### What the package does NOT expose

- A general "run any SQL" method on the service profile.
- Untyped result rows on either profile.
- `FINAL` keyword usage anywhere. Replay methods use `argMax`. The escape hatch is the only place `FINAL` can appear, and only by the caller's choice.

### Configuration

- `CLICKHOUSE_URL` — base URL.
- `CLICKHOUSE_ROLE` — `service` or `operator`. Required.
- `CLICKHOUSE_CREDENTIAL_REF` — secret reference (see `shared-secrets`).
- Service users authenticate as `polaris_service`. Operator workflows authenticate as `polaris_operator`. Role identities are managed by P1-003 grants and P11-004 secret provider.

### Tests

- Connection refuses to construct without a declared role.
- Service profile has no method that returns rows from `analytics_raw` outside the `replay` namespace.
- Operator-profile `replay.argMaxByEventKey` generates SQL that contains `argMax(... , _version)` and `GROUP BY (project_id, environment, event, event_id)` and does not contain `FINAL`.
- Operator-profile `raw.query` emits the escape-hatch metric and log line on every call.

## Acceptance Criteria

- [ ] Package exists in workspace.
- [ ] Wraps the official `@clickhouse/client` package; no custom protocol code.
- [ ] Exposes `service` and `operator` profiles; refuses to construct without a declared role.
- [ ] `projections`, `ingestLog`, `health` modules exist on the service profile.
- [ ] `replay.argMaxByEventKey` and `replay.countDistinctEvents` exist on the operator profile.
- [ ] `operator.raw.query` exists as the documented escape hatch, with metric and log emission per call.
- [ ] No method on either profile uses `FINAL` internally.
- [ ] Workspace rule blocks direct `@clickhouse/client` imports outside this package.
- [ ] Tests cover the constraints above.

## Checks

Run where possible:

```text
pnpm typecheck
pnpm test
pnpm lint
```

## Handoff

```text
Files changed:
  packages/shared-clickhouse/                       new package @polaris/shared-clickhouse
    README.md
    package.json (zod aligned to ^4.4.3 at integration)
    tsconfig.json (extends ../../tsconfig.base.json)
    src/{index,client,config,health,errors,types,ingest-log,raw,replay}.ts
    src/projections/{index,event-daily-counts}.ts
    src/internal/{exec,sql}.ts
    test/{client-profile,config,projection-sql,replay-sql}.test.ts

Commands run:
  pnpm install
  pnpm typecheck                              PASS
  pnpm lint                                   PASS (warnings only)
  pnpm format:check                           PASS
  pnpm test                                   PASS
  pnpm --filter @polaris/shared-clickhouse build  PASS

Checks passed:
  - Wraps the official @clickhouse/client; the only workspace package that imports it directly.
  - Two connection profiles (service / operator) chosen at config time. Constructor refuses to build without a declared role.
  - Service profile has no method returning rows from analytics_raw. Only projection tables + analytics_ingest_log.
  - Operator profile exposes replay.argMaxByEventKey / replay.countDistinctEvents over analytics_raw and an operator.raw.query escape hatch that emits a metric + structured log line per call.
  - FINAL keyword does not appear in any method on either profile.
  - Composes config schema from @polaris/shared-config (CLICKHOUSE_ROLE enforces service vs operator).

Known gaps:
  - Worker branched from a stale main HEAD (912b544) and did not follow the EXPECTED_BASE_COMMITS rebase preamble despite explicit instructions. Root-level pollution (self-contained tsconfig.base.json, biome.json, vitest.config.ts, package.json devDeps, .gitignore) was dropped at integration; only the package directory was kept.
  - Source used Zod 3 API patterns (errorMap, error.errors) which collided with the workspace Zod 4 baseline. Fixed at integration: errorMap removed in favor of the v4 `message` shape, .errors swapped to .issues.
  - Source used dot access on Record<string, unknown> params which violated noPropertyAccessFromIndexSignature; switched to bracket access at integration.
  - Live ClickHouse smoke test not exercised (no Docker daemon in the agent sandbox); covered by unit tests that mock the underlying client.
```
