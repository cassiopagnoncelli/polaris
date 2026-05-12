#!/usr/bin/env node
// Polaris ClickHouse local-stack bootstrap.
//
// Wraps `scripts/clickhouse-migrate.mjs` for the local/dev case: first applies
// the canonical SQL DDL under sql/clickhouse/, then applies the local-only
// init files under infra/clickhouse/init/ (which create role-bound users
// for service/operator profiles). Both directories are passed to the same
// migration runner, so the two phases share apply semantics.
//
// Production does NOT use this script — it applies only sql/clickhouse/.
// Local user provisioning in production comes from the secret provider
// (P11-004), not from a checked-in SQL file with hard-coded passwords.
//
// Usage:
//   node scripts/clickhouse-bootstrap-local.mjs                 # apply both
//   node scripts/clickhouse-bootstrap-local.mjs --dry-run       # plan only
//
// Env vars same as scripts/clickhouse-migrate.mjs.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { applyMigrations, parseArgs } from "./clickhouse-migrate.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

const SQL_ROOT = resolve(REPO_ROOT, "sql", "clickhouse");
const LOCAL_INIT_ROOT = resolve(REPO_ROOT, "infra", "clickhouse", "init");

function envOr(key, fallback) {
  const v = process.env[key];
  return v !== undefined && v !== "" ? v : fallback;
}

const logger = {
  info: (msg) => console.log(msg),
  error: (msg) => console.error(msg),
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = Boolean(args["dry-run"]);

  const client = {
    url: envOr("CLICKHOUSE_URL", "http://localhost:8123").replace(/\/+$/, ""),
    user: envOr("CLICKHOUSE_USER", "polaris"),
    password: envOr("CLICKHOUSE_PASSWORD", "polaris"),
  };

  logger.info(
    `[clickhouse-bootstrap-local] url=${client.url} user=${client.user}${dryRun ? " (dry-run)" : ""}`,
  );

  // Phase 1: canonical schema.
  logger.info("[clickhouse-bootstrap-local] phase=schema root=sql/clickhouse");
  try {
    const summary = await applyMigrations({ root: SQL_ROOT, client, dryRun, logger });
    logger.info(
      `[clickhouse-bootstrap-local] schema applied: ${summary.applied.length} file${summary.applied.length === 1 ? "" : "s"}, ${summary.totalStatements} statement${summary.totalStatements === 1 ? "" : "s"}`,
    );
  } catch (err) {
    logger.error(err.message);
    process.exitCode = 1;
    return;
  }

  // Phase 2: local-only user bootstrap. The infra/clickhouse/init/ tree
  // ships role-tied users with weak well-known passwords. Production
  // skips this phase entirely.
  logger.info("[clickhouse-bootstrap-local] phase=local-users root=infra/clickhouse/init");
  try {
    const summary = await applyMigrations({ root: LOCAL_INIT_ROOT, client, dryRun, logger });
    logger.info(
      `[clickhouse-bootstrap-local] local users applied: ${summary.applied.length} file${summary.applied.length === 1 ? "" : "s"}, ${summary.totalStatements} statement${summary.totalStatements === 1 ? "" : "s"}`,
    );
  } catch (err) {
    logger.error(err.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main();
}
