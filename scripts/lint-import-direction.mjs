#!/usr/bin/env node
// Polaris import-direction check.
//
// ADR-0007's second law: **the kernel imports no Polaris package.** The
// six-kind tree claims that a directory says what a thing IS, and layering is
// the half of that claim which is not visible in `ls`. `libs/governance`
// sitting beside `libs/bus` says they are different kinds of object; only an
// import graph says one of them may not reach for the other. Without a gate
// the law is a paragraph in an ADR, and the first package to break it breaks
// it silently — there is no type error in a domain library importing a
// Postgres pool, and no test fails.
//
// So this check derives the actual import graph and diffs it against the
// matrix ADR-0007 states.
//
// ## The matrix, in ADR-0007's vocabulary
//
//   libs/spec           the kernel. Imports NO `@polaris/*` package. Third
//                       party is by allow-list, one named entry per package
//                       with its reason; node builtins and type-only
//                       devDependencies are free.
//   libs/contracts      imports spec, and nothing else.
//   domain libs         identity, profiles, governance, engage, delivery,
//                       warehouse, data-graph, privacy, archive, tenancy.
//                       Import spec, contracts and each other; never bus,
//                       persistence, observability, runtime, auth or pipeline.
//   infrastructure libs bus, persistence, observability, runtime, auth,
//                       pipeline. Never import a domain lib.
//   units               `sync/`, `async/`, `apps/`. Compose both — a unit may
//                       import anything. Nothing may import a unit.
//   connectors          import spec and their `libs/delivery` port. Vendor
//                       SDKs and other third-party packages are theirs to
//                       choose; other `@polaris/*` packages are not.
//
// Domain and infrastructure are disjoint in BOTH directions, and that is the
// point rather than an oversight. `libs/` holds "domain meaning — pure logic
// with no runtime identity"; the shells are infrastructure; a unit is where
// the two meet. A domain library that imports a driver has acquired a runtime
// identity, and an infrastructure library that imports domain logic has
// acquired a meaning. Each direction is a different way of losing the same
// property.
//
// ## Five decisions this file had to make, and the reasoning
//
// **`libs/archive` is domain.** The card that added this check left the
// decision open — replay re-emits onto streams, so archive is either
// infrastructure or it is domain code that needs a port — and the graph turned
// out smaller than the question. `libs/archive/replay` does not import
// `@polaris/bus` at all; it declares one dependency, `@polaris/runtime-
// environments`, and that is its only forbidden edge. The single bus edge in
// the whole of `archive` is a TYPE-ONLY import of `Checkpoint` and
// `CheckpointStore` in `archive/writer`. Whatever re-emits onto streams is not
// in this library, so "give replay a port" is a follow-up with no code under it
// today.
//
// Domain, then, for the reasons that remain. ADR-0007's tree lists
// `archive/{writer,replay}/` inside the domain block, between `warehouse/` and
// `privacy/`. What archive knows is what an archived event IS and how a rebuilt
// one is derived from it — meaning, not transport. And classifying it as
// infrastructure would make both edges legal by definition and delete the
// question, where classifying it as domain banks them where somebody reads
// them. Reverse it by moving `archive` from DOMAIN to INFRASTRUCTURE below and
// re-running `--update-baseline`; the two entries are replaced by whatever
// `archive -> delivery-*` edges exist, and nothing else moves.
//
// **A type-only import of a workspace package still counts.** `import type
// { Checkpoint } from "@polaris/bus"` is erased at compile time, so it costs
// nothing at runtime — and it is still a layering fact: `archive/writer` cannot
// be built, typechecked or reasoned about without `bus` existing, and its own
// vocabulary is defined in bus's terms. The matrix is about which packages a
// package needs, and a type import needs the package. Both carve-outs are the
// kernel's, below, and neither reaches a workspace package: one is for
// type-only devDependencies, the other for the allow-listed notation.
//
// **`libs/tenancy` is domain; `libs/auth` and `libs/pipeline` are
// infrastructure.** All three sat in UNCLASSIFIED when this check landed —
// the check knew they existed and enforced nothing about them — because
// widening the matrix is an ADR's job and not a lint's. It went to the
// architect as `WNGW6`, and the ruling is ADR-0007's amendment of 2026-08-21.
//
// `tenancy` is meaning: which project, which environment, which write key.
// ADR-0007's tree lists it beside `contracts`, above the domain block, and
// what it holds is declared intent rather than a mechanism for carrying it.
// This is the expensive answer and it is taken anyway — it banks six edges of
// debt where calling tenancy infrastructure would have banked one and made
// the other five legal by definition.
//
// `pipeline` is plumbing, and the graph says so louder than the tree does:
// manifests, run lifecycle, the DLQ ledger and transport hooks, with every
// one of `bus`, `persistence-postgres`, `observability-logger` and
// `runtime-environments` imported to do it. Calling it domain would bank
// those four as debt against a library whose whole subject is the machinery.
//
// `auth` is a vendored IdP — JWKS, id-token verification, refresh — and its
// only dependency is `jose`. It draws no `@polaris/*` edge in either
// direction, so the graph is silent and the tree decides: a client of an
// external identity provider is infrastructure.
//
// **The kernel law is about the POLARIS graph.** ADR-0007 said "the kernel
// imports nothing", and `@polaris/spec -> zod` and `-> yaml` were banked as
// debt against the literal reading. They are not debt. Every event, envelope
// and catalog type in `libs/spec` IS a zod schema, and `catalog/loader.ts`
// parses the `definitions/` tree those types describe; a schema kernel
// importing the notation it expresses schemas in is design, and leaving it on
// a list titled debt invites somebody to spend a week hand-rolling a
// validator to pay off something that was never owed. So the law is that spec
// sits at the bottom of the Polaris graph, not at the bottom of the
// dependency graph.
//
// The allow-list rather than a blanket "third party is fine" is the second
// half of that ruling and it costs one line per package. `@polaris/spec ->
// axios` should still stop a build — a schema kernel making HTTP calls is
// exactly what this rule is for — so the notation is legitimate without the
// kernel's dependency surface going unwatched. `@polaris/spec ->
// @polaris/runtime-environments` is unaffected and stays debt: that one is
// the law's actual subject, and no allow-list reaches it, because the
// Polaris half of the rule has no exceptions at all.
//
// **A library in no list at all is a hard failure.** Not a violation, not
// baselineable: the run refuses. An enumeration that silently ignores what it
// does not recognise turns itself off for every package created after it, and
// this repository has the receipts — a scan root missing from a list does not
// report that root clean, it reports nothing about it. So `libs/<something-new>`
// stops the check until somebody classifies it, which costs one line at
// exactly the moment the author knows the answer.
//
// ## Why the burn-down baseline
//
// The matrix describes where the tree is going, and the tree is not there: the
// current graph violates it in the dozens. A check that fails fifty times on
// the day it lands is a check that gets commented out on the day it lands. So
// today's violations are frozen in `import-direction-baseline.json` and only
// NEW edges fail. The baseline is debt, not permission.
//
// An entry is an EDGE — `@polaris/governance -> @polaris/observability-logger`
// — rather than a file, so that clearing it is verifiable: the entry goes away
// when the last import between those two packages goes away, which is a unit
// of work somebody can finish. The cost of that grain, stated because it is a
// real one: a second file drawing an already-banked edge is not a new failure.
// Per-file entries would catch that and would also churn on every rename,
// which is how a baseline stops being read.
//
// Keying on package names rather than paths is deliberate too — pnpm resolves
// imports by name, so an edge survives a directory move, and this check was
// blocked until IJ4NN settled the names.
//
// ## What is not scanned, and why
//
// Test files, `tests/` and `scripts/`. A test importing a unit is a test doing
// its job, and the integration harness exists to reach across every layer at
// once. Declared `dependencies` in package.json are not read either: this
// check is about the direction of an IMPORT, and a declared-but-unimported
// dependency is a different defect with a different fix.
//
// Run it as:
//
//   node scripts/lint-import-direction.mjs
//   node scripts/lint-import-direction.mjs --update-baseline
//
// Set POLARIS_IMPORT_DIRECTION_ROOT to scan a fixture tree (used by the test).

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, "..");

/** Roots holding packages the matrix speaks about. */
export const SCAN_ROOTS = ["libs", "sync", "async", "apps", "connectors", "sdks", "definitions"];

/** Roots whose packages are units: runnables with a deployed identity. */
export const UNIT_ROOTS = ["sync", "async", "apps"];

/**
 * The domain block of ADR-0007's `libs/` tree.
 *
 * Three of these ten have no directory yet — `warehouse`, `data-graph` and
 * `privacy` are carried by later cards, as is the separately-kinded
 * `contracts`. They are listed anyway, exactly as `pnpm-workspace.yaml`
 * declares the three-deep connector glob before a connector exists: a
 * destination declared in advance makes the card that fills it a pure add,
 * where a destination discovered late makes it a pure add PLUS an argument
 * about layering.
 *
 * `tenancy` is the tenth, placed by ADR-0007's 2026-08-21 amendment; the
 * header says why.
 */
export const DOMAIN = [
  "identity",
  "profiles",
  "governance",
  "engage",
  "delivery",
  "warehouse",
  "data-graph",
  "privacy",
  "archive",
  "tenancy",
];

/**
 * The infrastructure block: shells, drivers, transport, telemetry — and, since
 * ADR-0007's 2026-08-21 amendment, the processor machinery and the IdP client.
 */
export const INFRASTRUCTURE = [
  "bus",
  "persistence",
  "observability",
  "runtime",
  "auth",
  "pipeline",
];

/**
 * Libraries the matrix does not place, each with why it is not placed.
 *
 * Empty since ADR-0007's 2026-08-21 amendment, which placed the three that
 * were here. The mechanism stays because the next library that genuinely
 * cannot be placed yet needs somewhere to wait that is not silence: an entry
 * exempts a library from the domain/infrastructure rules and from nothing
 * else, and it is the only way to say "undecided" out loud rather than by
 * omission. It is a hole in the matrix, so it costs a written reason, and the
 * test that reads those reasons is what keeps the cost from being zero.
 */
export const UNCLASSIFIED = new Map();

/**
 * Third-party packages the kernel may import, each with why.
 *
 * The list is the record of a decision, not a convenience. ADR-0007's
 * 2026-08-21 amendment rules that "the kernel imports nothing" is about the
 * Polaris graph — `libs/spec` sits at its bottom — and that the notation a
 * schema kernel expresses schemas in is design rather than debt. What it does
 * NOT rule is that any third-party dependency is fine, so each one is named
 * here and a package that is not named is still a violation.
 */
export const KERNEL_THIRD_PARTY = new Map([
  [
    "zod",
    "the schema notation itself: every event, envelope and catalog type in " +
      "this package IS a zod schema, so dropping it would not remove a " +
      "dependency, it would trade one for a hand-rolled validator",
  ],
  [
    "yaml",
    "the on-disk notation for `definitions/`: `catalog/loader.ts` parses the " +
      "declared intent that the catalog types in this package describe, and a " +
      "parser and the schema it feeds belong to the same layer",
  ],
]);

/** One rule class each, in the vocabulary the header states them in. */
export const RULES = {
  "kernel-imports-no-polaris-package":
    "libs/spec imports no @polaris package at all; third-party by allow-list only",
  "contracts-import-spec-only": "libs/contracts imports libs/spec and nothing else",
  "domain-never-infrastructure":
    "a domain lib never imports bus, persistence, observability, runtime, auth or pipeline",
  "infrastructure-never-domain": "an infrastructure lib never imports a domain lib",
  "nothing-imports-a-unit": "nothing imports a unit under sync/, async/ or apps/",
  "connectors-import-spec-and-their-port":
    "a connector imports libs/spec and its libs/delivery port, and no other @polaris package",
};

const NODE_BUILTINS = new Set(builtinModules);
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  ".turbo",
  ".vitest",
  "__tests__",
  "test",
  "tests",
  "fixtures",
  "__fixtures__",
]);
const SOURCE_EXT = new Set([".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"]);

/**
 * Files that describe how a package is BUILT rather than what it depends on.
 *
 * Every package in the tree carries a `vitest.config.ts`, and every one of
 * them imports `vitest`. Counting those made `@polaris/spec -> vitest` a
 * kernel violation in twenty-odd packages' worth of identical noise — an entry
 * that can never burn down, sitting in a file whose whole claim is that its
 * entries can. Test files go the same way and for the same reason: a test
 * reaches across layers because that is what a test is for.
 */
const TOOLING_FILE = /(\.(test|spec|config)\.[cm]?[jt]sx?)$|^vitest\.config\./;

/**
 * Blank out comments, keeping every other offset intact.
 *
 * Not a parser and not trying to be. It exists because a header comment that
 * NAMES a forbidden import — this file's own, for one — must not read as a
 * violation of the rule it is documenting. `lint-process-env` learnt the same
 * lesson from a comment saying a variable is not read.
 *
 * String literals survive, because the specifier lives in one. Comments are
 * replaced character-for-character with spaces so line numbers still hold.
 */
export function blankComments(source) {
  const out = source.split("");
  let i = 0;
  let mode = "code";
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1] ?? "";
    if (mode === "code") {
      if (ch === "/" && next === "/") {
        mode = "line";
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        mode = "block";
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        mode = ch;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (mode === "line") {
      if (ch === "\n") mode = "code";
      else out[i] = " ";
      i += 1;
      continue;
    }
    if (mode === "block") {
      if (ch === "*" && next === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        mode = "code";
        i += 2;
        continue;
      }
      if (ch !== "\n") out[i] = " ";
      i += 1;
      continue;
    }
    // Inside a string literal: preserved, but escapes must not end it early.
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === mode) mode = "code";
    i += 1;
  }
  return out.join("");
}

/**
 * Whether an import clause brings in types only.
 *
 * Two spellings: the statement-level `import type { A } from "x"`, and the
 * inline `import { type A, type B } from "x"` where every binding is a type.
 * Only rule one and rule two consult this, and only to spare the kernel a
 * devDependency it erases at compile time.
 */
function isTypeOnlyClause(clause) {
  if (/^type\s/.test(clause.trim())) return true;
  const braces = clause.match(/\{([^}]*)\}/);
  if (braces === null) return false;
  const bindings = braces[1]
    .split(",")
    .map((binding) => binding.trim())
    .filter((binding) => binding.length > 0);
  if (bindings.length === 0) return false;
  return bindings.every((binding) => /^type\s/.test(binding));
}

/**
 * Every module specifier a file imports, with its line and whether it is
 * type-only.
 *
 * The clause between `import`/`export` and `from` may not contain a quote or a
 * semicolon, which is what keeps a lazy match from spanning two statements and
 * attributing one file's specifier to another's keyword.
 */
export function readImports(source) {
  const code = blankComments(source);
  const found = [];
  const lineOf = (index) => code.slice(0, index).split("\n").length;

  const fromClause = /\b(import|export)\s+([^;'"`]*?)\bfrom\s*(['"])([^'"]+)\3/g;
  for (const match of code.matchAll(fromClause)) {
    found.push({
      specifier: match[4],
      typeOnly: isTypeOnlyClause(match[2]),
      line: lineOf(match.index),
    });
  }

  const sideEffect = /\bimport\s*(['"])([^'"]+)\1/g;
  const dynamic = /\b(?:import|require)\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
  for (const re of [sideEffect, dynamic]) {
    for (const match of code.matchAll(re)) {
      found.push({ specifier: match[2], typeOnly: false, line: lineOf(match.index) });
    }
  }
  return found;
}

/** The package a specifier names: `@polaris/bus/topology` -> `@polaris/bus`. */
export function specifierPackage(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function isBuiltin(specifier) {
  if (specifier.startsWith("node:")) return true;
  return NODE_BUILTINS.has(specifierPackage(specifier));
}

/**
 * What kind of object sits at a repo-relative directory.
 *
 * Keyed on the path, not the name: the path is what ADR-0007 assigns meaning
 * to, and `lint-package-name-congruence` is the check that keeps the two
 * saying the same thing. Reading the kind off the name would make this check
 * agree with a misnamed package instead of disagreeing with it.
 */
export function kindOf(dir) {
  const segments = dir.split("/");
  const [root, second] = segments;
  if (UNIT_ROOTS.includes(root)) return { kind: "unit" };
  if (root === "connectors") return { kind: "connector" };
  if (root === "sdks") return { kind: "sdk" };
  if (root === "definitions") return { kind: "definition" };
  if (root !== "libs" || second === undefined) return { kind: "outside" };
  if (second === "spec") return { kind: "spec", domain: second };
  if (second === "contracts") return { kind: "contracts", domain: second };
  if (DOMAIN.includes(second)) return { kind: "domain", domain: second };
  if (INFRASTRUCTURE.includes(second)) return { kind: "infrastructure", domain: second };
  if (UNCLASSIFIED.has(second)) return { kind: "unclassified", domain: second };
  return { kind: "unknown", domain: second };
}

function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // A nested package is walked as itself, not as part of its parent.
      if (existsPackage(full)) continue;
      walkFiles(full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (TOOLING_FILE.test(entry.name)) continue;
    const ext = entry.name.slice(entry.name.lastIndexOf("."));
    if (SOURCE_EXT.has(ext)) out.push(full);
  }
  return out;
}

function existsPackage(dir) {
  try {
    return statSync(join(dir, "package.json")).isFile();
  } catch {
    return false;
  }
}

/** Every workspace package under SCAN_ROOTS, as `{ dir, name, devDeps }`. */
export function indexPackages(root = DEFAULT_ROOT) {
  const packages = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (existsPackage(dir)) {
      let manifest = {};
      try {
        manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      } catch {
        manifest = {};
      }
      const name = typeof manifest.name === "string" ? manifest.name : null;
      if (name !== null) {
        packages.push({
          dir: relative(root, dir).split(sep).join("/"),
          name,
          devDeps: new Set(Object.keys(manifest.devDependencies ?? {})),
        });
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name));
    }
  };
  for (const scanRoot of SCAN_ROOTS) walk(join(root, scanRoot));
  packages.sort((a, b) => a.dir.localeCompare(b.dir));
  return packages;
}

/**
 * Libraries in no list, which stop the run.
 *
 * Separate from the violations because it is a different kind of problem: a
 * violation is debt the baseline may carry, and this is the check not knowing
 * what it is looking at. Baselining that would bank the blindness.
 */
export function unclassifiedLibraries(root = DEFAULT_ROOT) {
  return indexPackages(root)
    .filter((pkg) => kindOf(pkg.dir).kind === "unknown")
    .map((pkg) => ({ dir: pkg.dir, domain: kindOf(pkg.dir).domain }));
}

/**
 * Which rule an edge breaks, or null.
 *
 * Rule six is asked first and of every importer: "nothing imports a unit" has
 * no exceptions, and a domain library reaching into `sync/identity/resolver/v1`
 * should be reported as that rather than as whatever its own layer permits.
 */
function judge({ from, fromKind, targetName, targetKind, typeOnly }) {
  if (targetKind?.kind === "unit") return "nothing-imports-a-unit";

  switch (fromKind.kind) {
    case "spec":
      // The Polaris half has no exceptions — not for a type-only import, not
      // for a devDependency. That half IS the law, and the allow-list below
      // deliberately cannot reach it: `@polaris/spec ->
      // @polaris/runtime-environments` is the edge this rule exists for.
      if (targetName.startsWith("@polaris/")) return "kernel-imports-no-polaris-package";
      if (KERNEL_THIRD_PARTY.has(targetName)) return null;
      if (typeOnly && from.devDeps.has(targetName)) return null;
      return "kernel-imports-no-polaris-package";
    case "contracts":
      if (targetKind?.kind === "spec") return null;
      // The kernel's dev-dep exception, extended one package. Reading
      // "imports spec only" to forbid `import type { X } from "vitest"` makes
      // it a rule against testing the contracts, which cannot be the intent.
      if (typeOnly && from.devDeps.has(targetName)) return null;
      return "contracts-import-spec-only";
    case "domain":
      if (targetKind?.kind === "infrastructure") return "domain-never-infrastructure";
      return null;
    case "infrastructure":
      if (targetKind?.kind === "domain") return "infrastructure-never-domain";
      return null;
    case "connector":
      // Vendor SDKs are the point of a connector; only internal edges are
      // directional. `libs/delivery` is the port every family has today —
      // when `connectors/sources` and `connectors/warehouses` arrive with
      // ports of their own, this is the line that learns the family map.
      if (!targetName.startsWith("@polaris/")) return null;
      if (targetKind?.kind === "spec") return null;
      if (targetKind?.kind === "domain" && targetKind.domain === "delivery") return null;
      return "connectors-import-spec-and-their-port";
    default:
      // Units compose both. SDKs, definitions and anything parked in
      // UNCLASSIFIED are outside the matrix, and this check does not invent a
      // rule for them.
      return null;
  }
}

/** Every edge in the tree that the matrix forbids, as `{ from, to, rule, files }`. */
export function findViolations(root = DEFAULT_ROOT) {
  const packages = indexPackages(root);
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const edges = new Map();

  for (const from of packages) {
    const fromKind = kindOf(from.dir);
    if (fromKind.kind === "unknown") continue; // Reported separately, and fatally.
    for (const file of walkFiles(join(root, from.dir))) {
      const rel = relative(root, file).split(sep).join("/");
      let source;
      try {
        source = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const { specifier, typeOnly, line } of readImports(source)) {
        if (specifier.startsWith(".")) continue;
        if (isBuiltin(specifier)) continue;
        const targetName = specifierPackage(specifier);
        const target = byName.get(targetName);
        if (target !== undefined && target.dir === from.dir) continue;
        const targetKind = target === undefined ? null : kindOf(target.dir);
        const rule = judge({ from, fromKind, targetName, targetKind, typeOnly });
        if (rule === null) continue;
        const id = `${from.name} -> ${targetName}`;
        const seen = edges.get(id) ?? { from: from.name, to: targetName, rule, files: [] };
        const site = `${rel}:${String(line)}`;
        if (!seen.files.includes(site)) seen.files.push(site);
        edges.set(id, seen);
      }
    }
  }

  return [...edges.values()].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );
}

/** The baseline id for an edge. Package names, so a directory move keeps it. */
export function edgeId(violation) {
  return `${violation.from} -> ${violation.to}`;
}

export const BASELINE_PATH = resolve(__dirname, "import-direction-baseline.json");

export function readBaseline(path = BASELINE_PATH) {
  try {
    return new Set(JSON.parse(readFileSync(path, "utf8")).edges);
  } catch {
    return new Set();
  }
}

function main() {
  const root = process.env["POLARIS_IMPORT_DIRECTION_ROOT"] ?? DEFAULT_ROOT;

  const unknown = unclassifiedLibraries(root);
  if (unknown.length > 0) {
    console.error(
      `import-direction check: ${String(unknown.length)} library(s) in no layer.\n\n` +
        "This check enforces a matrix over named sets of libraries, and a set that\n" +
        "silently ignores what it does not recognise stops being a matrix — it turns\n" +
        "itself off for every package created after it was written.\n",
    );
    for (const { dir, domain } of unknown) console.error(`  ${dir}  (libs/${domain})`);
    console.error(
      "\nAdd the domain to DOMAIN, INFRASTRUCTURE, or UNCLASSIFIED with its reason in\n" +
        "scripts/lint-import-direction.mjs. One line, at the moment you know the answer.",
    );
    process.exitCode = 1;
    return;
  }

  const violations = findViolations(root);
  const ids = violations.map(edgeId);

  if (process.argv.includes("--update-baseline")) {
    // Carry the hand-written note forward. `lint-dead-exports` had its note
    // silently rewritten from a constant by a routine regeneration, and the
    // note is the only thing that makes a baseline read as debt rather than
    // as a list.
    let note = "Frozen debt: edges the matrix forbids and the tree still has. Shrink it.";
    try {
      const existing = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
      if (typeof existing.note === "string" && existing.note.length > 0) note = existing.note;
    } catch {
      // No baseline yet, or unreadable: the default note is correct.
    }
    writeFileSync(BASELINE_PATH, `${JSON.stringify({ note, edges: ids }, null, 2)}\n`);
    console.log(`import-direction check: baseline updated with ${String(ids.length)} edge(s)`);
    return;
  }

  const baseline = readBaseline();
  const fresh = violations.filter((violation) => !baseline.has(edgeId(violation)));
  const cleared = [...baseline].filter((id) => !ids.includes(id));

  if (cleared.length > 0) {
    console.log(
      `import-direction check: ${String(cleared.length)} baselined edge(s) are gone — run ` +
        "`node scripts/lint-import-direction.mjs --update-baseline` to bank it.",
    );
  }

  if (fresh.length === 0) {
    console.log(
      `import-direction check: no NEW edges against ADR-0007's matrix ` +
        `(${String(baseline.size)} baselined)`,
    );
    return;
  }

  console.error(
    `import-direction check: ${String(fresh.length)} new edge(s) the six-kind tree forbids.\n\n` +
      "Layering is what makes the tree true rather than decorative, and neither the\n" +
      "type system nor the test suite has an opinion about it.\n",
  );
  for (const violation of fresh) {
    console.error(`  ${edgeId(violation)}`);
    console.error(`    ${RULES[violation.rule]}`);
    for (const site of violation.files.slice(0, 5)) console.error(`      ${site}`);
    if (violation.files.length > 5) {
      console.error(`      ... and ${String(violation.files.length - 5)} more`);
    }
  }
  console.error(
    "\nCompose the two sides in a unit, or put the dependency behind a port. If the\n" +
      "matrix is what is wrong, that is an ADR-0007 amendment, not a baseline entry.",
  );
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
