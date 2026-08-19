/**
 * Run every catalog SQL definition against a live ClickHouse.
 *
 * `lint-trait-sql.mjs` checks which TABLES a definition reads. It cannot
 * check whether the COLUMNS exist, because that requires the schema — and
 * the schema lives in a server, not in the repo.
 *
 * That gap shipped three broken definitions. `orders_30d` selects
 * `profile_id` and filters on `day`; `event_daily_counts` has neither.
 * The trait has never run. Nothing caught it: the SQL is a string, so it
 * type-checks, and the table-name lint passes because the table name is
 * right.
 *
 * This runs each definition through `EXPLAIN PLAN`, which resolves
 * identifiers against the real schema without reading a row.
 *
 * NOT `EXPLAIN SYNTAX`, which was the first attempt: it parses and stops,
 * so it answers 200 for a query selecting a column that does not exist.
 * The check reported all definitions healthy while the broken one sat in
 * front of it — a check that passes on the bug it was written for.
 *
 * Needs a reachable ClickHouse, so it is NOT part of `pnpm lint` — it
 * belongs with the integration checks, and it skips (exit 0, loudly) when
 * no server answers. A check that failed CI on a laptop without docker
 * would be a check somebody deletes.
 *
 *   POLARIS_CLICKHOUSE_URL  default http://127.0.0.1:8123
 */

import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SCANNED_CATALOG_DIRS, stripComments, walk } from "./lint-trait-sql.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const URL_BASE = process.env["POLARIS_CLICKHOUSE_URL"] ?? "http://127.0.0.1:8123";

/**
 * Pull SQL string literals out of a definition module.
 *
 * Template literals containing a FROM clause. Crude on purpose: a parser
 * would be a second implementation of TypeScript, and the false positives
 * this shape produces are strings that ClickHouse then parses fine.
 */
function extractSql(source) {
  const stripped = stripComments(source);
  const out = [];
  for (const match of stripped.matchAll(/`([^`]*?\bFROM\b[^`]*?)`/gis)) {
    const sql = match[1];
    if (sql !== undefined && /\bselect\b/i.test(sql)) out.push(sql.trim());
  }
  return out;
}

async function reachable() {
  try {
    const response = await fetch(`${URL_BASE}/ping`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function explain(sql) {
  // Bound parameters are substituted with literals: EXPLAIN resolves
  // identifiers, and the parameter VALUES are irrelevant to whether a
  // column exists.
  const bound = sql
    .replace(/\{project:String\}/g, "'__check__'")
    .replace(/\{environment:String\}/g, "'production'")
    .replace(/\{day:String\}/g, "'2026-01-01'")
    .replace(/\{limit:UInt32\}/g, "1");
  const response = await fetch(URL_BASE, {
    method: "POST",
    body: `EXPLAIN PLAN ${bound}`,
  });
  if (response.ok) return null;
  return (await response.text()).split("\n")[0]?.slice(0, 200) ?? "unknown error";
}

async function main() {
  if (!(await reachable())) {
    // `--require-clickhouse` turns the skip into a failure. Without it this
    // exits 0 when there is no server, which is right for a developer running
    // `pnpm lint` on a laptop and WRONG for CI: a step that silently passes
    // when it checked nothing is a green tick for no work, which is the
    // failure mode this whole check was written to avoid one layer down.
    if (process.argv.includes("--require-clickhouse")) {
      console.error(`catalog-sql check: no ClickHouse at ${URL_BASE}, and --require-clickhouse`);
      console.error("was passed. This check is the only thing that reads the real schema, so");
      console.error("skipping it here would report a gate that ran nothing as a pass.");
      process.exitCode = 1;
      return;
    }
    console.log(`catalog-sql check: no ClickHouse at ${URL_BASE} — skipped.`);
    console.log("Start one and re-run; this check is the only thing that reads the real schema.");
    return;
  }

  const problems = [];
  let checked = 0;
  for (const dir of SCANNED_CATALOG_DIRS) {
    for (const file of walk(join(ROOT, "catalog", dir))) {
      for (const sql of extractSql(readFileSync(file, "utf8"))) {
        checked += 1;
        const error = await explain(sql);
        if (error !== null) problems.push({ file: relative(ROOT, file), error });
      }
    }
  }

  if (problems.length > 0) {
    console.error(`catalog-sql check: ${String(problems.length)} definition(s) do not run against`);
    console.error("the real schema. The table-name lint cannot see this — it checks names, not\n");
    for (const problem of problems) {
      console.error(`  ${problem.file}\n    ${problem.error}\n`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`catalog-sql check: ${String(checked)} definition(s) resolve against the schema.`);
}

await main();
