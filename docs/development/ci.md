# CI

Polaris uses GitHub Actions. Two workflow files cover the full quality gate
set documented in
[`09-engineering-standards.md` "CI Quality Gates"](../architecture/09-engineering-standards.md#ci-quality-gates)
plus the ClickHouse access enforcement from
[`07-clickhouse.md` "Access Control"](../architecture/07-clickhouse.md#access-control):

| Workflow                                    | Trigger                                              | Purpose                                                                                    |
| ------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)           | every PR and push to `main`, manual dispatch         | typecheck, lint (Biome + ClickHouse import rule), format check, tests, build, migration smoke |
| [`.github/workflows/integration.yml`](../../.github/workflows/integration.yml) | schedule (06:00 UTC), manual dispatch, `integration` PR label | Docker-backed checks against Postgres, Redis, RabbitMQ, ClickHouse                         |

The integration workflow is opt-in on PRs because the service matrix is slow
and still stabilising. Once the vertical-slice smoke test is reliable
(see [P5-001](../../agents/pm/kanban/done/P5-001-vertical-slice-smoke-test.md)),
the per-service jobs may graduate to required gates.


## Integration tests (broker + database)

```bash
pnpm test:integration
```

Runs `tests/integration/` against a live RabbitMQ and PostgreSQL. Skipped
unless `POLARIS_INTEGRATION=1`, so the default `pnpm test` on every PR
stays hermetic and Docker-free; the integration workflow sets it after
`docker compose up`.

These cover the transport properties that fakes cannot express — prefetch
pushing messages ahead of the handler, a quorum queue's TTL firing, a
stream attaching at a timestamp, the checkpoint store's SQL. They exist
because four defects survived a green unit suite during the RabbitMQ
migration, one of which could only be reproduced against a real broker.

Locally:

```bash
docker compose up -d --wait postgres rabbitmq && pnpm db:migrate && pnpm test:integration
```

The suite declares its own test-scoped topology and deletes it afterwards,
so it is safe against a shared dev broker.

## Required PR gates

Every PR must pass these jobs in `ci.yml`:

- **`static-analysis`** — `pnpm build` (so each package's `dist/` exists for
  cross-package type resolution), then `pnpm typecheck`, `pnpm lint`,
  `pnpm format:check`.
- **`test`** — `pnpm build` followed by `pnpm test`. The root `test` script
  runs the workspace Vitest suite plus the repo-root `scripts/` test suite
  (see "ClickHouse import-restriction check" below). The workspace suite
  includes the event-catalog validation tests in
  [`@polaris/shared-schemas`](../../packages/shared-schemas/test/catalog.test.ts),
  so no dedicated catalog runner is needed.
- **`migrations`** — applies every file in `db/migrations/` against a
  disposable PostgreSQL 17 service via `pnpm db:migrate`. dbmate does not
  ship a true dry-run mode, so a smoke `up` is the lightest validation
  available.

## ClickHouse import-restriction check

The architecture rejected a regex-based SQL lint (false positives on CTEs
and dynamic SQL, false negatives on aliased tables, decaying escape-hatch
comments — see
[07-clickhouse.md "Why grants instead of a lint"](../architecture/07-clickhouse.md#why-grants-instead-of-a-lint)).
Enforcement happens at two layers:

1. **Database grants** — the `polaris_service` role lacks `SELECT` on
   `analytics_raw`. Queries that go through the helper at the wrong
   profile cannot read the raw table at all.
2. **Workspace import rule** — only `packages/shared-clickhouse/` may
   import `@clickhouse/client`. Any other workspace package that adds a
   static `import`, dynamic `import()`, or `require()` for that
   specifier fails the build.

The import rule is implemented in
[`scripts/lint-clickhouse-imports.mjs`](../../scripts/lint-clickhouse-imports.mjs).
It walks `apps/`, `packages/`, `processors/`, `consumers/`, `catalog/`,
and `scripts/`, classifies each file's characters as code vs. comment
vs. string literal, and flags only real imports — comments that name
the package and prose in string literals do not trigger violations.

The script is wired into the root `pnpm lint` so it runs alongside Biome.
A targeted unit test in
[`scripts/__tests__/lint-clickhouse-imports.test.ts`](../../scripts/__tests__/lint-clickhouse-imports.test.ts)
seeds a temporary workspace tree with both allowed and disallowed callers
and asserts the violation set. The test runs as part of `pnpm test` via
`pnpm test:scripts`.

To verify a violation is caught locally:

```bash
# Drop a file outside packages/shared-clickhouse/ that imports the client...
echo 'import "@clickhouse/client";' > apps/ingester-api/src/_oops.ts

pnpm lint:clickhouse-imports
# => exits 1, prints the offending file:line and a pointer to docs/architecture/07-clickhouse.md

# Clean up
rm apps/ingester-api/src/_oops.ts
```

## Running the same checks locally

```bash
pnpm install
pnpm build           # produces dist/ for every package — typecheck and tests need this
pnpm typecheck
pnpm lint            # Biome + ClickHouse import-restriction
pnpm format:check
pnpm test            # workspace Vitest + scripts/ Vitest
```

The Makefile target `make ci` wraps the linter, typecheck, and test
trio (see [`Makefile`](../../Makefile)) but does not run the build
or format check. Use the explicit pnpm commands above when you want to
mirror CI exactly.

For the migration smoke step, run the local compose stack first:

```bash
docker compose up -d postgres
pnpm db:migrate
pnpm db:status
```

## Integration-tier checks

The integration workflow stands up real services and runs whatever
end-to-end suite is defined in the workspace. As of this writing, the
suite is a placeholder owned by:

- [P4-002 ClickHouse Ingestion Integration](../../agents/pm/kanban/done/P4-002-clickhouse-ingestion-integration.md)
- [P5-001 Vertical Slice Smoke Test](../../agents/pm/kanban/done/P5-001-vertical-slice-smoke-test.md)

### Opting into integration on a PR

Apply the `integration` label to a PR. The workflow's
`pull_request: types: [labeled, synchronize]` trigger will pick it up
on the next push. Remove the label to stop further runs.

### Running integration manually

From the GitHub Actions UI, pick `Integration` and **Run workflow**
against the branch you want to test. No label required.

### Running integration locally

The same services live in `docker-compose.yml`. Bring them up with the
Makefile target:

```bash
make up                          # docker compose up -d --wait
pnpm db:migrate                  # apply PostgreSQL migrations
# (real integration test commands land with P4-002 / P5-001)
make down                        # stop containers
make nuke                        # stop and wipe volumes
```

## Caching

Both workflows use `actions/setup-node`'s built-in `cache: pnpm`,
which keys on `pnpm-lock.yaml`. The cache restores the pnpm content-
addressable store; `pnpm install --frozen-lockfile` then links into
each workspace's `node_modules` from that store. The cache is shared
across workflow runs on the same branch family.

If a CI run mysteriously fails on a fresh install, suspect the cache
first: re-run the job with **Re-run all jobs with debug logging**
enabled, which clears the cache for that run.

## Node and pnpm versions

- Node major: **22** (current Active LTS, matches the `engines.node`
  field in [`package.json`](../../package.json)).
- pnpm: **10.30.0** (matches the `packageManager` field in
  [`package.json`](../../package.json)).

Both are pinned via the `NODE_VERSION` / `PNPM_VERSION` env vars at the
top of each workflow file so version bumps are a one-line change.
