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
// Scope: exported symbols in `packages/*/src`, which is where shared
// mechanisms live. A symbol is live if any production file outside its own
// package references it by name. Tests do not count — a helper exercised only
// by its own unit test is precisely the thing this check exists to surface.
//
// Run it as:
//
//   node scripts/lint-dead-exports.mjs
//
// Set POLARIS_DEAD_EXPORT_ROOT to scan a fixture tree (used by the unit test).

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, "..");

/** Where shared mechanisms live. Apps and processors are leaves; skip them. */
const PACKAGE_ROOT = "packages";

/** Where a call site counts from. */
const CONSUMER_DIRS = ["apps", "packages", "processors", "consumers", "scripts"];

/**
 * Symbols that are deliberately unreferenced and must stay.
 *
 * Keep this list SHORT and justified. An entry here is a promise that the
 * symbol is load-bearing despite having no caller; if you cannot write the
 * reason in one line, the honest move is to delete the symbol instead.
 */
const ALLOW = new Map([
  // Public SDK surface: consumed by applications outside this repository.
  ["packages/node-sdk", "published SDK surface"],
  ["packages/browser-sdk", "published SDK surface"],
  // Generated or contract types re-exported for downstream typing.
  ["packages/shared-schemas", "event contract types are the public schema surface"],
  // Built ahead of its callers: the 16 per-service cutovers that wire it are
  // separate cards, so the store has no in-repo caller until they land.
  // Remove this entry once the first service consumes it.
  ["packages/shared-project-config", "store lands before the services that wire it"],
  // Generated schema surface, consumed by control-plane-api and `polaris
  // config validate` in later cards.
  ["packages/project-config-schemas", "generated schema artifacts land before their consumers"],
]);

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git", "__tests__"]);
const SOURCE_EXT = new Set([".ts", ".mts", ".tsx"]);

/**
 * Extensions scanned when looking for USES of a symbol.
 *
 * Wider than `SOURCE_EXT` on purpose. Exports are declared in TypeScript, but
 * they are consumed by plain scripts too: `scripts/rabbitmq-provision.mjs`
 * imports `declareSuperStream`, `deleteSuperStream`, `deleteComponentQueues`
 * and `DEFAULT_STREAM_MAX_BYTES` from `@polaris/shared-transport`, and it is
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

export function findDeadExports(root = DEFAULT_ROOT) {
  const packageDir = join(root, PACKAGE_ROOT);
  const declared = new Map(); // symbol -> { file, pkg }

  for (const file of walk(packageDir)) {
    if (isTestFile(file) || isBarrel(file)) continue;
    const rel = relative(root, file);
    const pkg = rel.split(sep).slice(0, 2).join("/");
    if (ALLOW.has(pkg)) continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(DECLARATION)) {
      const name = match[1];
      if (name === undefined) continue;
      if (!declared.has(name)) declared.set(name, { file: rel, pkg });
    }
  }

  // Second pass: any production file OUTSIDE the declaring package that names
  // the symbol makes it live. Substring matching is deliberate — it errs
  // toward calling things live, so a report here is worth investigating.
  const referenced = new Set();
  for (const dir of CONSUMER_DIRS) {
    for (const file of walk(join(root, dir), [], REFERENCE_EXT)) {
      if (isTestFile(file)) continue;
      const rel = relative(root, file);
      const pkg = rel.split(sep).slice(0, 2).join("/");
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
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify({ note: "Frozen debt. Shrink it; do not grow it.", symbols: ids }, null, 2)}\n`,
    );
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
    `dead-export check: ${fresh.length} newly exported symbol(s) in packages/*/src with no\n` +
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
