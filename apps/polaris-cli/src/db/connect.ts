/**
 * Thin PostgreSQL bridge for the `polaris` CLI.
 *
 * The CLI is normally a thin HTTP client over `apps/control-plane-api/`, but
 * every v1 command lands ahead of the API service and reads or writes
 * PostgreSQL directly through `@polaris/persistence-postgres` — the catalog syncs, the
 * activation toggles, and the read-only inspection commands alike.
 *
 * When the control-plane API arrives, these commands will be re-pointed at
 * its endpoints; the sync planner stays the same.
 *
 * Connection settings:
 *
 *   - `POLARIS_DATABASE_URL` is checked first (CLI-specific override).
 *   - `DATABASE_URL` is the workspace-wide default also used by dbmate.
 *
 * There is deliberately NO built-in localhost fallback. A CLI that can
 * mutate production state should never guess which database it is pointed
 * at; `./polaris` at the repo root loads `.env.local` for the dev path
 * instead, the same way the Makefile does.
 *
 * No URL is provided => `ConfigError` (exit code 3), matching the rest of
 * the CLI's config-failure path.
 */
import { closeDb, createDb, type Database } from "@polaris/persistence-postgres";
import type { Kysely } from "kysely";
import { ConfigError } from "../errors.js";

export interface DbHandle {
  readonly db: Kysely<Database>;
  readonly close: () => Promise<void>;
}

export interface ConnectDbOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Optional explicit connection string override (passed by tests). */
  readonly connectionString?: string;
}

/**
 * Build a Kysely client over the configured PostgreSQL connection.
 *
 * The caller is responsible for calling `close()` once it's done with the
 * handle. Errors at connect time bubble up from the first query, not from
 * this factory — `pg` only opens connections on demand.
 */
export function connectDb(options: ConnectDbOptions = {}): DbHandle {
  const env = options.env ?? process.env;
  const explicit = options.connectionString;
  const fromEnv = trim(env["POLARIS_DATABASE_URL"]) ?? trim(env["DATABASE_URL"]);
  const connectionString = explicit ?? fromEnv;
  if (connectionString === undefined) {
    throw new ConfigError(
      [
        "no PostgreSQL connection configured: set POLARIS_DATABASE_URL or DATABASE_URL.",
        "",
        "Every v1 command reads or writes control-plane state directly, so this is",
        "required for all of them — not just the catalog syncs.",
        "",
        "For local development, `./polaris` loads .env.local for you:",
        "  ./polaris processors list",
        "",
        "Otherwise export it yourself:",
        "  export DATABASE_URL=postgres://polaris:polaris@localhost:5432/polaris?sslmode=disable",
      ].join("\n"),
    );
  }
  const db = createDb({ connectionString });
  return {
    db,
    close: () => closeDb(db),
  };
}

function trim(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
