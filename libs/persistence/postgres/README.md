# @polaris/shared-db

Typed PostgreSQL access for Polaris services and CLI commands, plus the
dbmate migration toolchain.

This package exports two surfaces:

- A `createDb(options)` factory that returns a typed Kysely client
  (`Kysely<Database>`) over `pg.Pool`.
- A `Database` interface describing the control-plane schema. The
  interface is the typed mirror of the live PostgreSQL schema; the SQL
  migrations in `db/migrations/` remain the source of truth.

The migration tool (`dbmate`) is also installed as a devDependency here, so
running migrations does not require a global install. Migration commands
are exposed as `pnpm db:*` scripts at the repo root — see
[`db/README.md`](../../../db/README.md) for the operator-facing workflow.

## Why both Kysely and SQL migrations?

Polaris keeps schema authorship in SQL (reviewable, portable, friendly to
DBAs) and query authoring in Kysely (typed, composable, friendly to
TypeScript services).

- **SQL migrations** are authoritative for what the database looks like.
- **`Database` interface** is hand-maintained to mirror the migrations and
  give services type safety at the query layer.
- Kysely never generates schema. Migrations never own query semantics.

This is the split the architecture docs require — see
`docs/architecture/09-engineering-standards.md` "PostgreSQL Access" and
"PostgreSQL Migrations".

## Usage

```ts
import { createDb, closeDb } from "@polaris/shared-db";

const db = createDb({
  connectionString: process.env.DATABASE_URL!,
  maxConnections: 10,
});

try {
  // Example shape (only valid once a migration has created `api_keys`):
  // const rows = await db
  //   .selectFrom("api_keys")
  //   .select(["api_key_id", "project_id", "environment"])
  //   .where("revoked_at", "is", null)
  //   .execute();
} finally {
  await closeDb(db);
}
```

For services that need full control over pool configuration (statement
timeouts, custom error handling, shared pool reuse), pass a pre-built
`pg.Pool`:

```ts
import { Pool } from "pg";
import { createDb } from "@polaris/shared-db";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL!,
  max: 20,
  statement_timeout: 5_000,
  idleTimeoutMillis: 30_000,
});

const db = createDb({ pool });
// caller now owns `pool` and is responsible for `pool.end()`
```

## Extending the schema

When a future task lands a migration that creates a new table:

1. Author the SQL migration in `db/migrations/` (see `db/README.md`).
2. In the same change, extend the `Database` interface in
   `libs/persistence/postgres/src/database.ts` to reflect the new table's
   columns and nullability. Use idiomatic Kysely column types
   (`Generated<T>`, `ColumnType<T, I, U>`) where the value differs at
   select/insert/update boundaries.
3. Run `pnpm --filter @polaris/shared-db build` to confirm the types
   compile.

Schema drift between SQL and the `Database` interface is a bug. If you
notice mismatch, add a follow-up to fix it; do not paper over with `any`.

## Type generation (future)

The `Database` interface is hand-maintained today. When the schema grows
past a handful of tables and hand-sync becomes painful, this is the
canonical place to wire up `kysely-codegen` (or equivalent) against the
live local database. The generated output should be checked into the repo
and reviewed alongside migrations. No generator is wired up yet.

## Migration commands (delegated to dbmate)

The package exposes the four migration commands. Prefer the
repo-root aliases (`pnpm db:migrate`, etc.) so the commands work no matter
where you are in the tree:

```bash
pnpm db:migrate      # apply pending migrations
pnpm db:rollback     # roll back the most recent migration
pnpm db:status       # list applied/pending migrations
pnpm db:create <slug>  # scaffold a new migration file
```

`DATABASE_URL` defaults to `postgres://polaris:polaris@localhost:5432/polaris?sslmode=disable`
(the local compose stack). Override by exporting `DATABASE_URL` before
running a script.
