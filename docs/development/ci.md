# CI

Polaris uses GitHub Actions. Two workflow files cover the full quality gate
set documented in
[`09-engineering-standards.md` "CI Quality Gates"](../architecture/09-engineering-standards.md#ci-quality-gates)
plus the ClickHouse access enforcement from
[`07-clickhouse.md` "Access Control"](../architecture/07-clickhouse.md#access-control):

| Workflow                                    | Trigger                                              | Purpose                                                                                    |
| ------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)           | every PR and push to `main`, manual dispatch         | typecheck, lint (Biome + ClickHouse import rule + raw-NUL check), format check, tests, build, migration smoke |
| [`.github/workflows/integration.yml`](../../.github/workflows/integration.yml) | schedule (06:00 UTC), manual dispatch, `integration` PR label | Docker-backed checks against Postgres, Redis, RabbitMQ, ClickHouse                         |

The integration workflow is opt-in on PRs because the service matrix is slow
and still stabilising. Once the vertical-slice smoke test is reliable
(see `P5-001`),
the per-service jobs may graduate to required gates.


## Integration tests (broker + database)

``bash
pnpm test:integration
``

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

``bash
docker compose up -d --wait postgres rabbitmq && pnpm db:migrate && pnpm test:integration
``

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
  [`@polaris/shared-schemas`](../../libs/spec/test/catalog.test.ts),
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
2. **Workspace import rule** — only `libs/persistence/clickhouse/` may
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

``bash
# Drop a file outside libs/persistence/clickhouse/ that imports the client...
echo 'import "@clickhouse/client";' > apps/ingester-api/src/_oops.ts

pnpm lint:clickhouse-imports
# => exits 1, prints the offending file:line and a pointer to docs/architecture/07-clickhouse.md

# Clean up
rm apps/ingester-api/src/_oops.ts
``

## Raw-NUL-byte check

A text source file containing a raw NUL byte is *binary* to the tools we
read code with, and both of them fail quietly:

- **ripgrep skips binary files during recursive search.** It prints no
  warning and exits with the same status as a genuine no-match, so the
  file simply stops appearing in repo-wide results.
- **git renders the diff as `Bin 9450 -> 9851 bytes`** instead of
  reviewable text, so changes to it cannot be read in review.

This is not hypothetical. `apps/control-plane-api/src/admin/pages/processors.ts`
and `libs/pipeline/src/activation-gate.ts` each built a
composite `Map` key with a NUL separator written as the byte itself, and
both files were invisible to every `rg` search until it was noticed by
accident.

NUL as a *separator* is correct — it is the one character an identifier
cannot contain, so joined keys cannot collide. Writing it as the raw byte
is what breaks the tooling. The `\u0000` escape is the identical
string at runtime and leaves the file as plain text.

The check is implemented in
[`scripts/lint-nul-bytes.mjs`](../../scripts/lint-nul-bytes.mjs). It walks
`apps/`, `packages/`, `processors/`, `consumers/`, `catalog/`, `scripts/`,
`sql/`, `db/`, `docs/`, and `tests/`, scanning an **allow-list** of text
extensions — so a genuinely binary file committed to the tree can never
fail the build. It is wired into the root `pnpm lint`, and
[`scripts/__tests__/lint-nul-bytes.test.ts`](../../scripts/__tests__/lint-nul-bytes.test.ts)
covers it via `pnpm test:scripts`.

To verify a violation is caught locally:

``bash
# printf expands \0 into a real NUL byte.
printf 'const k = "a\0b";\n' > libs/persistence/postgres/src/_oops.ts

pnpm lint:nul-bytes
# => exits 1, prints file:line and the byte offset of each NUL

# Clean up
rm libs/persistence/postgres/src/_oops.ts
``

## The declared-but-unread project-config key check

`pnpm lint:project-config-keys`, implemented in
[`scripts/lint-project-config-keys.mjs`](../../scripts/lint-project-config-keys.mjs).

Declaring a key in a component's `project-config.ts` is what creates operator
surface. The generator turns it into a JSON Schema artifact, the admin UI's
Variables panel renders a typed input for it, `polaris config set` accepts it,
`polaris config list` shows it, and `polaris config validate` reports on it —
all of which happen because the key is DECLARED. None of it requires the
component to READ the key.

So a declared-and-unread key is a control that looks live and is not: an
operator sets it, sees it stored, and nothing changes. meta-capi shipped
exactly that. `allow_replay` was declared and read by nothing, because replay
suppression runs in the destination runtime long before the deliverer the
config slice is handed to — and no type error or test could catch it, since the
key type-checked fine and the component's tests only covered what it read.

The check requires every key in a namespace's generated schema to appear by
name somewhere in the component's `src/` other than the declaration module
itself. Its `ALLOW` map is empty and should stay that way: a key that cannot be
shown to be read is a key an operator can set to no effect, and the honest fix
is to delete the declaration.

Removing a key is separately governed by the additive-only compatibility rule
in `pnpm config-schemas:check`, which fails on any removal. A removal that is
genuinely safe — because the key never had an effect to lose — takes a recorded
entry in that script's `REMOVAL_EXCEPTIONS`, with the reason.

To verify a violation is caught locally, add an unread key to any
`project-config.ts`, run `pnpm config-schemas`, then
`pnpm lint:project-config-keys`.

## Running the same checks locally

``bash
pnpm install
pnpm build           # produces dist/ for every package — typecheck and tests need this
pnpm typecheck
pnpm lint            # Biome + ClickHouse imports + raw-NUL + dead exports + process.env + project-config keys
pnpm format:check
pnpm test            # workspace Vitest + scripts/ Vitest
``

The Makefile target `make ci` wraps the linter, typecheck, and test
trio (see [`Makefile`](../../Makefile)) but does not run the build
or format check. Use the explicit pnpm commands above when you want to
mirror CI exactly.

For the migration smoke step, run the local compose stack first:

``bash
docker compose up -d postgres
pnpm db:migrate
pnpm db:status
``

## Integration-tier checks

The integration workflow stands up real services and runs whatever
end-to-end suite is defined in the workspace. As of this writing, the
suite is a placeholder owned by:

- `P4-002 ClickHouse Ingestion Integration`
- `P5-001 Vertical Slice Smoke Test`

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

``bash
make up                          # docker compose up -d --wait
pnpm db:migrate                  # apply PostgreSQL migrations
# (real integration test commands land with P4-002 / P5-001)
make down                        # stop containers
make nuke                        # stop and wipe volumes
``

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
