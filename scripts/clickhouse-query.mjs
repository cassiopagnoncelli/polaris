#!/usr/bin/env node
// Polaris ClickHouse smoke-query helper.
//
// One-shot read-only commands against a Polaris ClickHouse instance, useful
// for the vertical-slice smoke test (P5-001), the local-stack runbook, and
// for operators verifying that the schema applied cleanly. The script is
// intentionally narrow — it is NOT a substitute for the typed
// `libs/persistence/clickhouse/` helper, which services and the CLI must
// continue to use.
//
// Why a plain script and not a CLI command:
//   * The polaris CLI is the operator surface; this script ships with the
//     SQL DDL so a fresh `git clone && pnpm clickhouse:migrate` install can
//     verify the schema without bringing up the rest of the workspace.
//   * Same dependency-free posture as scripts/clickhouse-migrate.mjs:
//     native fetch, no @clickhouse/client import.
//
// Usage:
//   node scripts/clickhouse-query.mjs <command>
//
// Commands:
//   ping                  GET /ping (no auth) — verifies the server is up
//   schema                Lists Polaris tables/MVs/roles
//   ingest-log [--limit N] Recent rows from polaris.analytics_ingest_log
//   raw-count             count(DISTINCT event_id) on polaris.analytics_raw
//                         (uses the canonical dedupe-aware shape; see
//                          07-clickhouse.md "Query Patterns / Pattern 4")
//   event-daily-counts [--limit N]
//                         SELECT from the example projection table
//
// All commands exit non-zero on error and print the ClickHouse response
// body verbatim so operators can act on engine-level errors.
//
// Env vars (sensible local/dev defaults):
//   CLICKHOUSE_URL        default http://localhost:8123
//   CLICKHOUSE_USER       default polaris
//   CLICKHOUSE_PASSWORD   default polaris

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function envOr(key, fallback) {
  const v = process.env[key];
  return v !== undefined && v !== "" ? v : fallback;
}

// Flags that take a value. Listed explicitly rather than inferred from the
// next token, so a future boolean flag cannot silently swallow a positional.
const VALUE_FLAGS = new Set(["limit"]);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    // `--limit N` as well as `--limit=N`: the usage string documents the
    // spaced form, so accept it.
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (VALUE_FLAGS.has(name) && next !== undefined && !next.startsWith("--")) {
      out[name] = next;
      i += 1;
      continue;
    }
    out[name] = true;
  }
  return out;
}

async function runQuery(client, sql, format = "Pretty") {
  const url = `${client.url}/?` + new URLSearchParams({ default_format: format }).toString();
  const auth = "Basic " + Buffer.from(`${client.user}:${client.password}`).toString("base64");
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      Authorization: auth,
    },
    body: sql,
  });
  const body = await resp.text();
  if (!resp.ok) {
    throw new Error(`ClickHouse ${resp.status} ${resp.statusText}:\n${body.trim()}`);
  }
  return body;
}

// Pretty format renders zero rows as an empty body, which reads like the
// command silently failed. Say so instead.
function writeResult(body) {
  process.stdout.write(body.trim() === "" ? "(no rows)\n" : body);
}

async function ping(client) {
  const resp = await fetch(`${client.url}/ping`);
  const body = await resp.text();
  if (!resp.ok) {
    throw new Error(`Ping failed: ${resp.status} ${resp.statusText}\n${body}`);
  }
  process.stdout.write(body);
}

async function schema(client) {
  const sql = `
    SELECT name, engine, total_rows
    FROM system.tables
    WHERE database = 'polaris'
    ORDER BY name
  `;
  writeResult(await runQuery(client, sql));
}

async function ingestLog(client, opts) {
  const limit = Number.parseInt(String(opts.limit ?? "20"), 10);
  if (!Number.isFinite(limit) || limit <= 0 || limit > 10_000) {
    throw new Error("--limit must be a positive integer <= 10000");
  }
  const sql = `
    SELECT
      project_id, environment, event,
      event_id, schema_version,
      occurred_at, ingested_at,
      processor_name, processor_version,
      _consumed_at, _topic, _partition, _offset
    FROM polaris.analytics_ingest_log
    ORDER BY _consumed_at DESC
    LIMIT ${limit}
  `;
  writeResult(await runQuery(client, sql));
}

async function rawCount(client) {
  // Canonical dedupe-aware shape from 07-clickhouse.md Pattern 4. Never
  // SELECT * from analytics_raw, never FINAL by default — count distinct
  // event_id sidesteps the merge-state question entirely.
  const sql = `
    SELECT count(DISTINCT event_id) AS distinct_event_count,
           min(occurred_at)         AS earliest_occurred_at,
           max(occurred_at)         AS latest_occurred_at
    FROM polaris.analytics_raw
  `;
  writeResult(await runQuery(client, sql));
}

async function eventDailyCounts(client, opts) {
  const limit = Number.parseInt(String(opts.limit ?? "20"), 10);
  if (!Number.isFinite(limit) || limit <= 0 || limit > 10_000) {
    throw new Error("--limit must be a positive integer <= 10000");
  }
  // Projection table: pre-summed counters. The defensive outer sum()
  // collapses any unmerged duplicate keys at query time.
  const sql = `
    SELECT
      project_id, environment, event, occurred_date,
      sum(event_count) AS events
    FROM polaris.event_daily_counts
    GROUP BY project_id, environment, event, occurred_date
    ORDER BY occurred_date DESC, project_id, event
    LIMIT ${limit}
  `;
  writeResult(await runQuery(client, sql));
}

function usage() {
  process.stderr.write(`usage: clickhouse-query <command>

Commands:
  ping                              GET /ping (no auth)
  schema                            List polaris.* tables, MVs, roles
  ingest-log [--limit N]            Recent rows from analytics_ingest_log (default 20)
  raw-count                         count(DISTINCT event_id) on analytics_raw (dedupe-safe)
  event-daily-counts [--limit N]    Recent rows from the example projection (default 20)

Env: CLICKHOUSE_URL, CLICKHOUSE_USER, CLICKHOUSE_PASSWORD
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd) {
    usage();
    process.exitCode = 1;
    return;
  }

  const client = {
    url: envOr("CLICKHOUSE_URL", "http://localhost:8123").replace(/\/+$/, ""),
    user: envOr("CLICKHOUSE_USER", "polaris"),
    password: envOr("CLICKHOUSE_PASSWORD", "polaris"),
  };

  try {
    switch (cmd) {
      case "ping":
        await ping(client);
        break;
      case "schema":
        await schema(client);
        break;
      case "ingest-log":
        await ingestLog(client, args);
        break;
      case "raw-count":
        await rawCount(client);
        break;
      case "event-daily-counts":
        await eventDailyCounts(client, args);
        break;
      default:
        usage();
        process.exitCode = 1;
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main();
}
