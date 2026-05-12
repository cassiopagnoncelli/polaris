# P5-002: Developer Runbook

Status: Ready

## Goal

Document how a developer runs the local vertical slice and troubleshoots common failures.

## Required Reading

- [Project README](../../README.md)
- [Observability and Operations](../../architecture/08-observability-and-operations.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)

## Dependencies

- P5-001

## Write Scope

Allowed:

```text
docs/development/
docs/implementation/
README.md
```

Forbidden:

```text
apps/
packages/
processors/
consumers/
sql/
infra/
```

## Implementation Notes

Document:

- install
- local services
- migrations
- starting ingester
- sending a test event
- starting processor
- checking ClickHouse
- common failures
- reset/cleanup commands

Do not invent commands that do not exist.

### ClickHouse query patterns reference

Include a "Querying ClickHouse" section in the runbook that covers, with concrete copy-paste examples:

- The role model: `polaris_service` for application code, `polaris_operator` for ad-hoc investigation.
- How to connect with each role from `clickhouse-client` and from the `shared-clickhouse` package.
- The `argMax(col, _version)` aggregation pattern for `analytics_raw` reads, accessed through `client.replay.argMaxByEventKey(...)`.
- `count(DISTINCT event_id)` for unique-count checks.
- Why plain `SELECT * FROM analytics_raw` returns merge-state duplicates, and why service code cannot do it (the role refuses).
- When to use the `operator.raw.query` escape hatch and what shows up in the metric/log trail when you do.

Link out to [07-clickhouse.md / Query Patterns](../../architecture/07-clickhouse.md) and [07-clickhouse.md / Access Control](../../architecture/07-clickhouse.md) for the full rules.

## Acceptance Criteria

- [ ] Developer runbook exists.
- [ ] Commands match implemented scripts.
- [ ] Troubleshooting section exists.
- [ ] Links to architecture docs exist.
- [ ] ClickHouse query patterns reference section exists with the four examples and the escape-hatch guidance.

## Checks

Run where possible:

```text
rg -n "TODO|TBD" docs/development docs/implementation README.md
```

## Handoff

```text
Files changed:
  docs/development/getting-started.md  (NEW; the day-one developer runbook)
  README.md                            (NEW; repo-root nav doc into docs/)

Commands run:
  pnpm install --frozen-lockfile
  pnpm build
  pnpm typecheck
  pnpm lint
  pnpm format:check
  pnpm test          (workspace Vitest + scripts Vitest)
  rg -n "TODO|TBD" docs/development docs/implementation README.md
    -> only matches in historical task cards (P6-004, P6-005, P6-006), not in
       the new runbook or README.

Checks passed:
  pnpm typecheck — all workspace projects + scripts + tests
  pnpm lint — Biome + lint:clickhouse-imports (no violations)
  pnpm format:check — 391 files clean
  pnpm test — 1029 passed, 1 skipped (workspace) + 59 passed (scripts)
  rg TODO/TBD — no new TODOs in scoped paths

Known gaps:
  - The runbook references `apps/control-plane-api/` as future work (P6-000);
    until that lands, the CLI talks to PostgreSQL directly via
    `@polaris/shared-db`. The runbook flags this in the "Run the polaris CLI"
    subsection.
  - `processors disable` does NOT accept `--reason` in v1 (only
    `destinations disable` does). The runbook documents this explicitly so
    operators do not invent the flag.
  - The ingester defaults to `POLARIS_HTTP_PORT=3000`, but the smoke runner
    and the API doc both pin `http://localhost:8080`. The runbook tells the
    reader to set `POLARIS_HTTP_PORT=8080` when starting the ingester for the
    smoke. This is a documentation choice, not a source change.
  - No deeper integration with the SDK handbook beyond a cross-reference;
    the SDK handbook owns SDK-specific operations.
```

