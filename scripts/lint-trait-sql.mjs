#!/usr/bin/env node
// Polaris computed-SQL check.
//
// SQL in a computed-trait or audience definition may read PROJECTIONS. It
// may not read `analytics_raw` or `analytics_processed`.
//
// Both directories are scanned because both are cron-driven SQL against
// the shared cluster with identical blast radius. Audiences arrived after
// this check did, and a definition source outside its scope would be a
// hole in exactly the shape the check exists to close — the same way
// `catalog/policy` sat outside the dead-export check.
//
// This is a lint rather than a runtime guard because the failure it
// prevents happens at 03:00 on a cron, on a shared cluster, with nobody
// watching: an open scan over the widest table in the warehouse — the one
// holding raw customer data — issued by a service-role client that has no
// business reading it. By the time it shows up as a slow dashboard, it has
// been running nightly for a month.
//
// A trait that genuinely needs a shape of history no projection carries
// should get a NEW PROJECTION. That is a reviewable artifact with an engine
// choice and a sort key someone signed off on, rather than a bespoke scan
// buried in a definition file.
//
// Run it as:
//
//   node scripts/lint-trait-sql.mjs
//
// Set POLARIS_TRAIT_ROOT to scan a fixture tree (used by the unit test).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, "..");

/** Directories whose `.ts` definitions carry cron-driven SQL. */
export const SCANNED_CATALOG_DIRS = ["traits", "audiences", "reverse-etl"];

/** Tables a definition may read. Mirrors READABLE_PROJECTIONS in the catalog. */
export const ALLOWED_TABLES = [
  "event_daily_counts",
  "session_daily_metrics",
  // The person-dimensioned projection. Without it no per-profile trait is
  // computable at all — the other two group by day and event only.
  "profile_event_daily_counts",
];

/**
 * Tables a trait may never read, by name.
 *
 * Listed explicitly rather than derived as "not allowed", so the message can
 * say WHICH table and why — an author who wrote `analytics_raw` needs to be
 * told about projections, not handed a regex.
 */
export const FORBIDDEN_TABLES = ["analytics_raw", "analytics_processed", "analytics_events_queue"];

/** `FROM x` / `JOIN x`, with or without the `polaris.` prefix. */
const TABLE_REFERENCE = /\b(?:from|join)\s+(?:polaris\.)?([a-z_][a-z0-9_]*)/gi;

/**
 * Strip comments before scanning.
 *
 * The first version of this check scanned raw file contents and flagged
 * `orders-30d.ts` for reading a table called `the` — matched out of the
 * prose "fed from `analytics_raw` by a materialized view". A definition's
 * DOC is where an author explains which source it reads and why, so prose
 * naming a forbidden table is exactly what good documentation looks like.
 * A check that punished it would be trained away within a week.
 */
export function stripComments(contents) {
  return contents.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/** Extract every table a SQL string reads. */
export function tablesReferenced(sql) {
  const found = new Set();
  for (const match of sql.matchAll(TABLE_REFERENCE)) {
    const table = match[1];
    if (table !== undefined) found.add(table.toLowerCase());
  }
  return [...found];
}

/** Problems in one definition file's contents. */
/**
 * Event names the catalog registers.
 *
 * Read from `catalog/events/**.yaml` rather than a list here, so an event
 * added or retired moves this check with it. The ingester rejects anything
 * absent from the catalog as `unknown_event`, which is the contract this
 * borrows: if the platform will not accept the event, a definition
 * counting it counts nothing.
 */
export function registeredEventNames(root) {
  const names = new Set();
  // NOT `walk`, which collects `.ts` and skips everything else -- the
  // catalog's event entries are YAML. Using it returned an empty set, and
  // the check then flagged every definition including the correct ones.
  // Failing closed was the right direction, but see the throw below: an
  // empty set is a broken check, not a catalog with no events.
  const files = [];
  const descend = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) descend(full);
      else if (full.endsWith(".yaml") || full.endsWith(".yml")) files.push(full);
    }
  };
  descend(join(root, "catalog", "events"));

  for (const file of files) {
    // `name: checkout.started` at column zero. The catalog entries are
    // flat maps and `name` appears once; a YAML parser here would be a
    // dependency for one field.
    const match = /^name:\s*(\S+)\s*$/m.exec(readFileSync(file, "utf8"));
    if (match?.[1] !== undefined) names.add(match[1]);
  }

  // A check that reads no events would flag every definition, which reads
  // as a catalog full of bugs rather than as a check pointed at the wrong
  // directory. That is how this was written the first time.
  if (names.size === 0) {
    throw new Error(
      `trait-sql check: no registered events found under ${join(root, "catalog", "events")}. ` +
        "The check reads `name:` from the event YAML; if the catalog moved, move this with it.",
    );
  }
  return names;
}

/**
 * Event-name literals a definition filters on.
 *
 * `event = 'x'`, `event IN ('x', 'y')`. Only the `event` column, because
 * that is the one whose values are a closed set the catalog owns.
 */
export function eventLiteralsReferenced(sql) {
  const out = new Set();
  for (const match of sql.matchAll(/\bevent\s*=\s*'([^']*)'/gi)) {
    if (match[1] !== undefined) out.add(match[1]);
  }
  for (const match of sql.matchAll(/\bevent\s+in\s*\(([^)]*)\)/gi)) {
    for (const literal of (match[1] ?? "").matchAll(/'([^']*)'/g)) {
      if (literal[1] !== undefined) out.add(literal[1]);
    }
  }
  return out;
}

export function findTraitSqlProblems(contents, file, knownEvents) {
  const problems = [];
  for (const table of tablesReferenced(stripComments(contents))) {
    if (FORBIDDEN_TABLES.includes(table)) {
      problems.push({
        file,
        table,
        reason:
          `reads \`${table}\`, which holds raw customer data and is the widest table in the ` +
          "warehouse. Traits read projections; if none carries the shape you need, add a " +
          "projection — that is a reviewable artifact, a cron-time full scan is not",
      });
      continue;
    }
    if (!ALLOWED_TABLES.includes(table)) {
      problems.push({
        file,
        table,
        reason:
          `reads \`${table}\`, which is not an allowed projection. Allowed: ` +
          `${ALLOWED_TABLES.join(", ")}`,
      });
    }
  }

  // Event names are a closed set the catalog owns, and EXPLAIN cannot see
  // this: `'order.completed'` is a string, and a string is valid SQL
  // whatever it says. `orders_30d` counted exactly that for a day -- an
  // event the ingester rejects as `unknown_event`, so the trait produced
  // no rows, the `recent_purchasers` audience reading it had no members,
  // and Braze received nothing. Every layer was individually correct.
  //
  // Skipped when the caller passes no set, so the exported helper stays
  // usable in unit tests that check only table rules.
  if (knownEvents !== undefined) {
    for (const event of eventLiteralsReferenced(stripComments(contents))) {
      if (knownEvents.has(event)) continue;
      problems.push({
        file,
        table: event,
        reason:
          `filters on event \`${event}\`, which the catalog does not register. The ingester ` +
          "rejects it as `unknown_event`, so this definition counts a name nothing can emit. " +
          "Use a registered event, or register this one under catalog/events/",
      });
    }
  }
  return problems;
}

// The catalog is a workspace package, so it has its OWN `node_modules` once
// pnpm links its dependencies. Walking it made this check read zod's test
// suite and report that `union.test.ts` queries a projection called `both`.
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git"]);

export function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts") && !full.endsWith("types.ts") && !full.endsWith("index.ts")) {
      out.push(full);
    }
  }
  return out;
}

function main() {
  const root = process.env["POLARIS_TRAIT_ROOT"] ?? DEFAULT_ROOT;
  const files = [];
  for (const catalogDir of SCANNED_CATALOG_DIRS) {
    files.push(...walk(join(root, "catalog", catalogDir)));
  }
  const knownEvents = registeredEventNames(root);
  const problems = [];
  for (const file of files) {
    problems.push(
      ...findTraitSqlProblems(readFileSync(file, "utf8"), relative(root, file), knownEvents),
    );
  }

  if (problems.length > 0) {
    console.error(`trait-sql check: ${String(problems.length)} definition(s) read a table or an`);
    console.error("event they must not. These run on a cron against a shared cluster.\n");
    for (const problem of problems) {
      console.error(`  ${problem.file}  ${problem.reason}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `trait-sql check: ${String(files.length)} definition(s) read only allowed projections ` +
      `and registered events.`,
  );
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main();
}
