# P0-010: Shared ClickHouse Client Package

Status: Backlog

## Goal

Create the workspace package that owns all ClickHouse access for services and the CLI. The package's typed read methods are the only sanctioned path against `analytics_raw`-derived data; ad-hoc direct queries route through a separate operator workflow.

## Required Reading

- [ClickHouse / Query Patterns](../../architecture/07-clickhouse.md)
- [ClickHouse / Access Control](../../architecture/07-clickhouse.md)
- [Engineering Standards / ClickHouse Access](../../architecture/09-engineering-standards.md)
- [Codex Instructions](../../instructions/codex.md)

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
Commands run:
Checks passed:
Known gaps:
```
