/**
 * Polaris Kysely client factory.
 *
 * Wraps `pg.Pool` in a `Kysely<Database>` instance using the official
 * `PostgresDialect`. Callers do not import `kysely` or `pg` directly for
 * the connection construction — they receive a configured client from this
 * package so pool lifecycle and SQL dialect stay consistent across services
 * and CLI commands.
 *
 * The typed `Database` schema lives in `./database.ts`. Each table-owning
 * task (P6-*, P7-*, P9-*, P11-*) extends it when its migration lands.
 *
 * This factory is intentionally small. It does not own:
 *   - migrations (those run through dbmate; see `db/README.md`)
 *   - retries (callers wrap their own queries; Kysely is the SQL layer)
 *   - observability (services attach their own loggers/metrics via Pino
 *     and Prometheus hooks once shared-logger / shared-config / metrics
 *     packages land)
 */

import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";

import type { Database } from "./database.js";

export type { Database };

/**
 * Options accepted by {@link createDb}. Either `connectionString` or a
 * fully populated `pool` must be provided. When both are absent, the
 * factory throws — defaults are the caller's responsibility (via
 * `shared-config`, env vars, or explicit wiring), not this package's.
 */
export type CreateDbOptions = {
  /**
   * PostgreSQL connection string, e.g.
   * `postgres://polaris:polaris@localhost:5432/polaris`.
   * Ignored when `pool` is supplied.
   */
  connectionString?: string;
  /**
   * Pre-built `pg.Pool`. When supplied, takes precedence over
   * `connectionString`. Useful for services that want full control over
   * pool configuration (size, idle timeout, statement timeout, etc.).
   */
  pool?: pg.Pool;
  /**
   * Maximum number of clients in the pool. Defaults to `pg`'s built-in
   * default (10) when constructing from a connection string. Ignored when
   * `pool` is supplied.
   */
  maxConnections?: number;
};

/**
 * Build a typed Kysely client over a PostgreSQL connection.
 *
 * The returned client owns the underlying `pg.Pool` only when this
 * function constructed it. When the caller supplies its own `pool`, the
 * caller is responsible for ending it. Use {@link closeDb} to release
 * resources held by a factory-built client.
 */
export function createDb(options: CreateDbOptions): Kysely<Database> {
  const pool = resolvePool(options);
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
}

/**
 * Close the underlying `pg.Pool` and end the Kysely client.
 *
 * Safe to call on a client built by {@link createDb}. Callers that
 * supplied their own pool should end it themselves and call this only on
 * the Kysely instance (`db.destroy()`).
 */
export async function closeDb(db: Kysely<Database>): Promise<void> {
  await db.destroy();
}

function resolvePool(options: CreateDbOptions): pg.Pool {
  if (options.pool) {
    return options.pool;
  }
  if (!options.connectionString) {
    throw new Error("@polaris/shared-db: createDb requires either `pool` or `connectionString`.");
  }
  const config: pg.PoolConfig = {
    connectionString: options.connectionString,
  };
  if (options.maxConnections !== undefined) {
    config.max = options.maxConnections;
  }
  return new pg.Pool(config);
}
