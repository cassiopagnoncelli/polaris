/**
 * Thin PostgreSQL bridge for the `polaris` CLI.
 *
 * The CLI is normally a thin HTTP client over `apps/control-plane-api/`, but
 * the projects/sources sync commands are the first surface that lands ahead
 * of the API service. They write directly to PostgreSQL through
 * `@polaris/shared-db` so operators can materialize catalog declarations
 * before the API ships.
 *
 * When the control-plane API arrives, these commands will be re-pointed at
 * its endpoints; the sync planner stays the same.
 *
 * Connection settings:
 *
 *   - `POLARIS_DATABASE_URL` is checked first (CLI-specific override).
 *   - `DATABASE_URL` is the workspace-wide default also used by dbmate.
 *
 * No URL is provided => `ConfigError` (exit code 3), matching the rest of
 * the CLI's config-failure path.
 */
import { type Database, closeDb, createDb } from "@polaris/shared-db";
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
      "POLARIS_DATABASE_URL (or DATABASE_URL) is required for commands that materialize catalog declarations.",
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
