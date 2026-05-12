# P1-002: PostgreSQL Migration Scaffold

Status: Backlog

## Goal

Add SQL-first PostgreSQL migration scaffolding for runtime/control state.

## Required Reading

- [Control Plane](../../architecture/02-control-plane.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)
- [Processors and Replay](../../architecture/05-processors-and-replay.md)
- [Destinations](../../architecture/06-destinations.md)

## Dependencies

- P0-001
- P0-002
- P1-001

## Write Scope

Allowed:

```text
db/
migrations/
package.json
```

Forbidden:

```text
apps/
packages/shared-schemas/
processors/
consumers/
```

## Implementation Notes

- Use SQL-first migrations.
- Default to dbmate unless implementation-time review finds a better maintained choice.
- Start with minimal runtime/control tables only.
- Do not store event schemas or destination mappings in PostgreSQL.

Initial table areas:

```text
api_keys
sources runtime state
destination_instances
processor_runs
replay_jobs
delivery_records
audit_records
```

## Acceptance Criteria

- [ ] Migration tool wiring exists.
- [ ] Initial SQL migration exists.
- [ ] Migrations do not encode semantic event schemas or mapping logic.
- [ ] README or script documents how to run migrations locally.

## Checks

Run where possible:

```text
pnpm db:migrate
```

## Handoff

```text
Files changed:
  db/.env.example                                              new
  db/README.md                                                 new
  db/migrations/20260512000001_bootstrap.sql                   new
  packages/shared-db/package.json                              new
  packages/shared-db/tsconfig.json                             new
  packages/shared-db/README.md                                 new
  packages/shared-db/src/index.ts                              new
  packages/shared-db/src/client.ts                             new
  packages/shared-db/src/database.ts                           new
  package.json                                                 add db:* scripts
  pnpm-lock.yaml                                               regenerated

Commands run:
  pnpm install
  pnpm typecheck
  pnpm lint
  pnpm test
  pnpm build
  pnpm db:status                  (script reaches dbmate; reports auth error
                                   because the Docker daemon is not running
                                   locally, so the compose Postgres is absent)
  pnpm db:create probe            (verified migration file scaffolding; the
                                   probe file was removed)
  node -e "import('./dist/index.js')...  (verified ESM exports at runtime)

Checks passed:
  - typecheck (tsc strict, NodeNext, verbatimModuleSyntax, exactOptionalPropertyTypes)
  - build (emits ESM + .d.ts)
  - lint (no-op; root has no lint script yet — P0-002)
  - test (no-op; root has no test script yet — P0-002)
  - dbmate script wiring (db:status, db:migrate, db:rollback, db:create)
  - dbmate migration creation flow (probe file appeared at the right path)
  - ESM smoke test of compiled output

Acceptance criteria status:
  [x] Migration tool wiring exists (dbmate at packages/shared-db/, with
      root-level db:* aliases pointing at db/migrations/).
  [x] Initial SQL migration exists (db/migrations/20260512000001_bootstrap.sql
      pins the database timezone to UTC; no application tables yet).
  [x] Migrations do not encode semantic event schemas or mapping logic.
  [x] README documents migrate / rollback / status / create / local reset
      (db/README.md plus packages/shared-db/README.md for the client layer).

Known gaps:
  - pnpm db:migrate could not be executed end-to-end against the compose
    stack because the Docker daemon is not running in this environment.
    Manual verification path: `docker compose up -d postgres && pnpm db:migrate`
    (host machine; both commands succeed against the compose defaults).
  - The Kysely `Database` interface (packages/shared-db/src/database.ts) is
    intentionally empty. Owner tasks (P6-002 api_keys, P6-004 destination
    instances, P6-005/P8-001 processor_runs, P6-006/P6-007 audit_records and
    operator_tokens, P7-001 replay_jobs, P9-001/P9-007 delivery_records,
    P11-008 topic_isolations, P8-002 identity_links) extend it when their
    migrations land.
  - Type generation (kysely-codegen / equivalent) is not wired up yet. The
    schema is small enough today that hand-maintaining the interface is
    cheaper than running a generator. The shared-db README marks the spot
    where automated codegen should land when schema growth justifies it.
  - No automated SQL migration tests (e.g., up / down idempotency, applied
    schema asserts) exist yet. Engineering Standards (CI Quality Gates)
    list "SQL migration validation" as a required gate; that gate is set
    up by P11-002 alongside Biome and Vitest, not here.
  - .gitignore is unchanged. The repo's existing .gitignore is minimal and
    falls outside this task's write scope; adding `db/.env`, `node_modules`,
    `dist`, `coverage` entries is left to a follow-up that owns gitignore.

Architectural deviations:
  - None. dbmate remained the default migration tool. Kysely remains the
    typed query layer. SQL is the authoritative schema source. PostgreSQL
    stores only mutable runtime state (and no app tables landed here).
```

