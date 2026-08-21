#!/usr/bin/env node
// Polaris dead-export check.
//
// This repository has a specific, repeated failure: a mechanism gets built,
// wired, Zod-validated, documented, sometimes printed to operators — and read
// by nothing. Every instance was found by accident, months later, by someone
// reading the code for an unrelated reason:
//
//   - `processor_activations` had no runtime reader, so `polaris processors
//     disable` changed a database cell and stopped nothing.
//   - `partitions_consumed_concurrently` sat in six manifests, two Zod
//     schemas and `processors show` with no runtime reader at all.
//   - `observeLagMs` has never been called, so two Prometheus alerts cannot
//     fire and two Grafana panels plot an empty series.
//   - `publishToDlq` appears only in doc comments telling hosts to call it.
//
// None of these is a type error, none fails a test, and each one reads as
// finished work. So this check asks the one question the type system cannot:
// does anything actually CALL this?
//
// Scope: exported symbols under the roots where shared mechanisms live —
// `libs/` (domain libraries) and `sdks/` (published clients). A
// symbol is live if any production file outside its own package references it
// by name. Tests do not count — a helper exercised only by its own unit test is
// precisely the thing this check exists to surface.
//
// Run it as:
//
//   node scripts/lint-dead-exports.mjs
//
// Set POLARIS_DEAD_EXPORT_ROOT to scan a fixture tree (used by the unit test).

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, "..");

/**
 * Where shared mechanisms live. Apps and processors are leaves; skip them.
 *
 * One epoch now: ADR-0007 settled the libraries into `libs/` and the published
 * clients into `sdks/`, and IJ4NN deleted the flat root they came from. While
 * both were live this list named all three, because a root missing here is not
 * a root reported clean -- it is one nothing is ever scanned under.
 *
 * `connectors/` and `definitions/` are deliberately absent. A root belongs here
 * when a package this check already scans moves INTO it, and neither receives
 * one: `definitions/` receives `catalog/`, which has never been scanned, and
 * `connectors/` was built from `sync/destinations/`, which has never been
 * scanned either. Adding either would be new scanning surface arriving
 * disguised as a rename — and for connectors it would report every one of them
 * dead, since the delivery engine loads a vendor adapter by name rather than
 * importing it.
 */
const PACKAGE_ROOTS = ["libs", "sdks"];

/**
 * Where a call site counts from.
 *
 * Wider than the declaration roots on purpose: a reference only ever makes a
 * symbol live, so a root missing here manufactures false deaths rather than
 * hiding real ones. That is the direction a move breaks in — the day `libs/`
 * holds the libraries and is not listed here, every cross-package call site in
 * the platform disappears at once and the check reports it as dead.
 *
 * `catalog/` is absent, and that is a live gap rather than a decision: three
 * `governance` symbols are called from `definitions/policy` and sit in the
 * baseline as dead because nothing looks there. Listing `definitions/` means
 * 0DIPB's rename is what surfaces them — as a "now have a caller" note on the
 * baseline it already regenerates, which is the card that should absorb it.
 */
const CONSUMER_DIRS = [
  "apps",
  "sync",
  "async",
  "scripts",
  "libs",
  "sdks",
  "connectors",
  "definitions",
];

/**
 * Symbols that are deliberately unreferenced and must stay.
 *
 * Keep this list SHORT and justified. An entry here is a promise that the
 * symbol is load-bearing despite having no caller; if you cannot write the
 * reason in one line, the honest move is to delete the symbol instead.
 *
 * Keys are paths. While the move cards were in flight each entry carried both
 * its old and its new path, so the promise could not expire silently the moment
 * a package moved; IJ4NN landed the last of them, and the duplicates went with
 * the directory that made them necessary.
 */
const ALLOW = new Map([
  // Public SDK surface: consumed by applications outside this repository.
  ["sdks/node", "published SDK surface"],
  // There is deliberately no `sdks/web` twin. A `browser-sdk` entry sat here
  // for months and never matched anything — the browser SDK has always been
  // `web-sdk` — so the web SDK has been scanned all along, and its 29
  // unreferenced exports are in the baseline as debt rather than allowed as
  // surface. Carrying the misspelling into the new epoch would have
  // allow-listed a real, scanned package at the moment it moved, which is the
  // one thing a `git mv` must not do; writing it correctly would have done the
  // same thing and looked like a typo fix. So the entry is gone and the check
  // is unchanged: `sdks/web` is scanned, exactly as it always was. Whether
  // those 29 are surface or debt is a real question, and it is not one a move
  // card gets to answer in passing.
  // Generated or contract types re-exported for downstream typing.
  ["libs/spec", "event contract types are the public schema surface"],
  // Generated schema surface, consumed by control-plane-api and `polaris
  // config validate` in later cards.
  ["libs/tenancy/config-schemas", "generated schema artifacts land before their consumers"],
]);

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git", "__tests__"]);
const SOURCE_EXT = new Set([".ts", ".mts", ".tsx"]);

/**
 * Extensions scanned when looking for USES of a symbol.
 *
 * Wider than `SOURCE_EXT` on purpose. Exports are declared in TypeScript, but
 * they are consumed by plain scripts too: `scripts/rabbitmq-provision.mjs`
 * imports `declareSuperStream`, `deleteSuperStream`, `deleteComponentQueues`
 * and `DEFAULT_STREAM_MAX_BYTES` from `@polaris/bus`, and it is
 * the ONLY caller of several of them. Scanning references as TypeScript-only
 * reported all four as dead — the provisioner that creates every stream in
 * the platform was invisible to the check.
 */
const REFERENCE_EXT = new Set([".ts", ".mts", ".tsx", ".mjs", ".cjs", ".js"]);

// Values only. A type with no external reference is weak evidence — it may
// simply describe an internal shape — whereas an exported FUNCTION that
// nothing calls is either missing wiring or dead code. Every instance this
// check was written for is a value.
const DECLARATION =
  /^export\s+(?:declare\s+)?(?:async\s+)?(?:function|class|const)\s+([A-Za-z_$][\w$]*)/gm;

function walk(dir, out = [], extensions = SOURCE_EXT) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(full, out, extensions);
    else if (extensions.has(entry.slice(entry.lastIndexOf(".")))) out.push(full);
  }
  return out;
}

/** A test file's references do not make a symbol live. */
function isTestFile(path) {
  return (
    path.includes(`${sep}test${sep}`) ||
    path.includes(`${sep}tests${sep}`) ||
    path.endsWith(".test.ts") ||
    path.endsWith(".spec.ts")
  );
}

/** Barrel re-exports are plumbing, not use. */
function isBarrel(path) {
  return path.endsWith(`${sep}index.ts`);
}

const packageKeyCache = new Map();

/**
 * The package a file belongs to, as a repo-relative path.
 *
 * The first two path segments were exactly right while every package sat one
 * level under a single flat root. The six-kind tree has `libs/persistence/postgres` and
 * `connectors/destinations/braze/v1`, where two segments name a GROUPING
 * directory instead: every `libs/persistence/*` would collapse into one
 * "package", so a call from the clickhouse driver into the postgres one would
 * read as internal and its target would be reported dead — and no ALLOW entry
 * for any of them could be written at all, since the key would name the group.
 *
 * So a package is the nearest ancestor holding a package.json, which is what
 * pnpm means by one too. It settles the three-deep `sync` and `async` units on
 * the way past, where two segments have always named a stage rather than a unit.
 *
 * The two-segment rule survives as the fallback for a tree with no package.json
 * above the file at all — a fixture, or a checkout nobody has installed.
 */
function packageKeyFor(root, file) {
  const stop = resolve(root);
  const start = dirname(file);
  const cached = packageKeyCache.get(start);
  if (cached !== undefined) return cached;

  let dir = start;
  let key;
  while (dir !== stop && dir.startsWith(stop + sep)) {
    if (existsSync(join(dir, "package.json"))) {
      key = relative(root, dir).split(sep).join("/");
      break;
    }
    dir = dirname(dir);
  }
  key ??= relative(root, file).split(sep).slice(0, 2).join("/");
  packageKeyCache.set(start, key);
  return key;
}

export function findDeadExports(root = DEFAULT_ROOT) {
  packageKeyCache.clear();
  const declared = new Map(); // symbol -> { file, pkg }

  for (const packageRoot of PACKAGE_ROOTS) {
    // A root with nothing in it yet reads as empty rather than as an error,
    // which is what lets both epochs be listed before either has moved.
    for (const file of walk(join(root, packageRoot))) {
      if (isTestFile(file) || isBarrel(file)) continue;
      const rel = relative(root, file);
      const pkg = packageKeyFor(root, file);
      if (ALLOW.has(pkg)) continue;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(DECLARATION)) {
        const name = match[1];
        if (name === undefined) continue;
        if (!declared.has(name)) declared.set(name, { file: rel, pkg });
      }
    }
  }

  // Second pass: any production file OUTSIDE the declaring package that names
  // the symbol makes it live. Substring matching is deliberate — it errs
  // toward calling things live, so a report here is worth investigating.
  const referenced = new Set();
  for (const dir of CONSUMER_DIRS) {
    for (const file of walk(join(root, dir), [], REFERENCE_EXT)) {
      if (isTestFile(file)) continue;
      const pkg = packageKeyFor(root, file);
      const source = readFileSync(file, "utf8");
      for (const [name, origin] of declared) {
        if (referenced.has(name)) continue;
        if (pkg === origin.pkg) continue;
        if (source.includes(name)) referenced.add(name);
      }
    }
  }

  const dead = [];
  for (const [name, origin] of declared) {
    if (!referenced.has(name)) dead.push({ name, file: origin.file });
  }
  return dead.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
}

/**
 * Existing debt, recorded so the check can ship as a gate today.
 *
 * A lint that fails 500 times on the day it lands gets disabled on the day it
 * lands — which would make it one more mechanism nobody reads. So the current
 * set is frozen and only NEW dead exports fail. The baseline is debt, not
 * approval: shrinking it is a standing invitation, and `--update-baseline`
 * rewrites it after a deliberate cleanup.
 */
const BASELINE_PATH = resolve(__dirname, "dead-exports-baseline.json");

function readBaseline() {
  try {
    return new Set(JSON.parse(readFileSync(BASELINE_PATH, "utf8")).symbols);
  } catch {
    return new Set();
  }
}

function main() {
  const root = process.env["POLARIS_DEAD_EXPORT_ROOT"] ?? DEFAULT_ROOT;
  const dead = findDeadExports(root);
  const ids = dead.map(({ name, file }) => `${file}::${name}`);

  if (process.argv.includes("--update-baseline")) {
    // Carry the existing note forward. It is hand-written and names which
    // card is expected to consume each banked symbol — the only thing that
    // makes this file readable as debt rather than as a list. Regenerating
    // it from a constant silently deleted that, which is how the note came
    // to be rewritten by a routine `--update-baseline` run.
    let note = "Frozen debt. Shrink it; do not grow it.";
    try {
      const existing = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
      if (typeof existing.note === "string" && existing.note.length > 0) note = existing.note;
    } catch {
      // No baseline yet, or unreadable: the default note is correct.
    }
    writeFileSync(BASELINE_PATH, `${JSON.stringify({ note, symbols: ids }, null, 2)}\n`);
    console.log(`dead-export check: baseline updated with ${ids.length} symbol(s)`);
    return;
  }

  const baseline = readBaseline();
  const fresh = dead.filter(({ name, file }) => !baseline.has(`${file}::${name}`));
  const fixed = [...baseline].filter((id) => !ids.includes(id));

  if (fixed.length > 0) {
    console.log(
      `dead-export check: ${fixed.length} baselined symbol(s) now have a caller or are gone — ` +
        "run `node scripts/lint-dead-exports.mjs --update-baseline` to bank it.",
    );
  }
  if (fresh.length === 0) {
    console.log(`dead-export check: no NEW unreferenced exports (${baseline.size} baselined)`);
    return;
  }
  console.error(
    `dead-export check: ${fresh.length} newly exported symbol(s) in ` +
      `{${PACKAGE_ROOTS.join(",")}}/**/src with no\n` +
      "production call site. Either the wiring is missing or the code is dead — this repo has\n" +
      "shipped both, repeatedly, and neither is a type error or a test failure.\n",
  );
  for (const { name, file } of fresh) console.error(`  ${file}  ${name}`);
  console.error(
    "\nIf it is load-bearing without a caller, add its package to ALLOW with the reason.",
  );
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
