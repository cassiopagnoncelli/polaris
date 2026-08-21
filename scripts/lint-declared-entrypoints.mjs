#!/usr/bin/env node
// Polaris declared-entrypoint check.
//
// Every path a package.json points a consumer at -- `main`, `types`, each
// `bin`, every leaf of `exports` -- is a promise that something emits that
// file. Nothing checked the promise, in either direction: TypeScript never
// reads `exports`, the build compiles whatever `src/` holds without consulting
// the manifest, and a subpath nobody has imported yet cannot fail a test.
//
// So `@polaris/bus` advertised `./stream-range-reader` for as long as that
// module has been called `partition-stream-readers.ts`. The rename happened
// during the RabbitMQ move -- the planned single-purpose reader landed holding
// two entry points, `readStreamRange` and `followStream`, and was named for
// both -- while the manifest kept the name from the plan. Anyone writing
// `import { readStreamRange } from "@polaris/bus/stream-range-reader"` would
// have got ERR_MODULE_NOT_FOUND out of a subpath the package itself
// advertises, and read it as their own mistake.
//
// It was found by accident, by `PHYFV`'s worker, which had to tell three
// reasons apart for a file missing from an injected copy -- stale, unbuilt, or
// declared-but-never-emitted -- and hit a real instance of the third. That is
// the argument for a gate rather than a fix: this class is invisible until
// somebody writes the import, and by then it looks like their bug.
//
// ## How it decides, without a build
//
// By mapping the target back through the package's own tsconfig, not by
// looking for the built file. `dist/x.js` and `dist/x.d.ts` are emitted from
// `src/x.ts`, so "does anything emit this?" is a question about `src/`. Two
// properties follow, and both are the point:
//
//   - it needs no build, and a check that needs a build is one that gets
//     skipped;
//   - it gives the same verdict on a cold worktree as on a built one.
//     `existsSync("dist/x.js")` would give neither: `pnpm build` does not
//     clean, so a `dist/` left behind by a module deleted last week answers
//     yes, and a fresh worktree answers no for every package at once.
//
// A target OUTSIDE the package's `outDir` is checked by existence instead,
// because nothing compiles it: a checked-in `./polaris.css` is either there or
// it is not. A package with no `outDir` to read is that case throughout.
//
// ## What it does not check
//
// Whether the emitted module exports the symbols a caller expects. That is
// typechecking, and it happens the moment somebody writes the import; this
// check is about the import resolving at all.
//
// A subpath PATTERN (`"./features/*": "./dist/features/*.js"`) is checked down
// to the directory its matches would come from and no further, since the
// target names a family rather than a file. That still catches the way a
// pattern goes stale -- the directory moves -- and nothing here writes one
// today.
//
// A fallback array (`["./dist/a.js", "./dist/b.js"]`) means "the first that
// resolves", and the shared `declaredEntrypoints` reads every member as
// required, so one dead alternative among live ones would be reported. Nothing
// here writes one either; the day something does, this is where it gets
// taught.
//
// Run it as:
//
//   node scripts/lint-declared-entrypoints.mjs
//
// Set POLARIS_ENTRYPOINT_ROOT to scan a fixture tree (used by the test).

import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { declaredEntrypoints } from "./sync-injected-workspace-copies.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, "..");

/** Build output and dependencies: neither holds a package this repo declares. */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git"]);

/**
 * Extensions a source file may carry.
 *
 * The target's own extension is dropped and each of these tried, rather than
 * mapping `.js -> .ts` and `.mjs -> .mts` exactly. The looser rule can only
 * MISS a fault; an exact one invents them the first time a package emits
 * through a shape the mapping does not know about.
 */
export const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
];

/**
 * Strip `//` and block comments from JSONC, leaving string literals alone.
 *
 * tsconfig.json is JSONC and `tests/tsconfig.json` uses the licence. A naive
 * regex strip is not an option here: `"src/**\/*.ts"` contains the sequence
 * that ENDS a block comment, so a stripper that does not track quoting cuts a
 * config in half at an include glob.
 */
export function stripJsonComments(text) {
  let out = "";
  let index = 0;
  let inString = false;
  while (index < text.length) {
    const char = text[index];
    if (inString) {
      out += char;
      if (char === "\\") {
        out += text[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      index += 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/** `./src/` and `src` are the same directory; say it one way. */
function normalizeDir(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/^\.\//, "").replace(/\/+$/, "");
  return trimmed.length === 0 ? "." : trimmed;
}

/**
 * Where a package's build reads from and writes to.
 *
 * Read out of the package's own tsconfig.json, because that is the file its
 * `build` script runs (`tsc -p tsconfig.json`, in every package here).
 *
 * `outDir` is `null` when there is none to read -- no tsconfig, an unparseable
 * one, or one that declares no `outDir`, in which case tsc emits beside the
 * sources and nothing lands in a `dist/` at all. Every target is then checked
 * by existence, which is the right answer for a package that is not compiled.
 *
 * `sourceRoots` is a list because `rootDir` is optional and tsc infers it from
 * the inputs. `src` then `.` covers what this repository does -- `libs/*`
 * declare `src`, `definitions/*` declare `.` -- and a guess that accepts a
 * source which IS there errs in the direction a guess should.
 */
export function emitPlan(packageDir) {
  let options;
  try {
    const parsed = JSON.parse(
      stripJsonComments(readFileSync(join(packageDir, "tsconfig.json"), "utf8")),
    );
    options = parsed?.compilerOptions;
  } catch {
    return { outDir: null, sourceRoots: [] };
  }
  const outDir = normalizeDir(options?.outDir);
  const rootDir = normalizeDir(options?.rootDir);
  return { outDir, sourceRoots: rootDir === null ? ["src", "."] : [rootDir] };
}

/** The part of `rel` inside `outDir`, or `null` when it is not inside it. */
function insideOutDir(rel, plan) {
  if (plan.outDir === null) return null;
  if (plan.outDir === ".") return rel;
  if (rel === plan.outDir) return "";
  return rel.startsWith(`${plan.outDir}/`) ? rel.slice(plan.outDir.length + 1) : null;
}

/**
 * The source files whose compilation would produce `target`.
 *
 * `null` when nothing compiles it -- the target sits outside `outDir`, or the
 * package has none -- which is the caller's signal to ask whether the file is
 * simply there.
 */
export function sourcesFor(target, plan) {
  const rel = target.replace(/^\.\//, "");
  const inner = insideOutDir(rel, plan);
  if (inner === null) return null;
  // `.d.ts` first: the generic rule would leave `x.d` behind.
  const stem = inner.replace(/\.d\.[cm]?ts$/, "").replace(/\.[^./]+$/, "");
  return plan.sourceRoots.flatMap((root) =>
    SOURCE_EXTENSIONS.map((extension) => join(root, `${stem}${extension}`)),
  );
}

/** The directory a pattern's matches come from: `dist/features/*.js` -> `dist/features`. */
export function patternDirectory(target) {
  const rel = target.replace(/^\.\//, "");
  return normalizeDir(rel.slice(0, rel.indexOf("*")).replace(/[^/]*$/, ""));
}

/**
 * The source directories whose compilation would fill `dirRel`.
 *
 * The pattern half of `sourcesFor`, and `null` for the same reason.
 */
export function sourceDirsFor(dirRel, plan) {
  const inner = insideOutDir(dirRel, plan);
  if (inner === null) return null;
  return plan.sourceRoots.map((root) => (inner === "" ? root : join(root, inner)));
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether anything in `packageDir` can produce `target`.
 *
 * @returns {{emitted: boolean, wanted: string[]}} `wanted` is what would have
 * satisfied it, for the report -- a check that says only "missing" makes the
 * reader work out what it was looking for.
 */
export function resolveTarget(packageDir, target, plan) {
  if (target.includes("*")) {
    const directory = patternDirectory(target);
    const sources = sourceDirsFor(directory, plan);
    const wanted = sources ?? [directory];
    return { emitted: wanted.some((path) => isDirectory(join(packageDir, path))), wanted };
  }
  const sources = sourcesFor(target, plan);
  if (sources === null) {
    const rel = target.replace(/^\.\//, "");
    return { emitted: existsSync(join(packageDir, rel)), wanted: [rel] };
  }
  return { emitted: sources.some((path) => existsSync(join(packageDir, path))), wanted: sources };
}

/**
 * Every directory holding a package.json.
 *
 * Walked from the root rather than read off a list of roots, because a root
 * missing from a list is not a root reported clean -- it is one nothing is
 * ever scanned under, and this repository has six of them plus `blueprints/`,
 * which is deliberately outside the workspace and declares entrypoints all the
 * same.
 *
 * Symlinked directories are not followed. A pm worktree plants an `agents`
 * symlink back to the main checkout, and walking it would scan another tree's
 * packages and report them against this one's sources.
 */
export function packageDirs(root) {
  const found = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = readdirSync(rel === "" ? root : join(root, rel));
    } catch {
      return;
    }
    if (entries.includes("package.json") && rel !== "") {
      found.push(rel);
      return; // a package is a leaf; a package.json inside one is not ours
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
      const full = join(root, rel, entry);
      try {
        if (!lstatSync(full).isDirectory()) continue;
      } catch {
        continue; // raced with another session's write
      }
      walk(rel === "" ? entry : `${rel}/${entry}`);
    }
  };
  walk("");
  return found.sort((a, b) => a.localeCompare(b));
}

/**
 * Entrypoints a package declares and nothing emits.
 *
 * Reports the target and what would have satisfied it, because the failure has
 * two legal repairs -- write the module, or drop the declaration -- and which
 * one is right is a judgement about what the package should expose. For
 * `@polaris/bus` it was the second: the module exists under another name and
 * the whole of its surface already leaves through the root export.
 */
export function findUnemittedEntrypoints(root = DEFAULT_ROOT) {
  const problems = [];
  for (const path of packageDirs(root)) {
    const packageDir = join(root, path);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    } catch {
      problems.push({ path, target: "package.json", wanted: [], reason: "is unparseable" });
      continue;
    }
    const plan = emitPlan(packageDir);
    for (const target of declaredEntrypoints(manifest)) {
      const { emitted, wanted } = resolveTarget(packageDir, target, plan);
      if (emitted) continue;
      problems.push({
        path,
        target,
        wanted,
        reason:
          plan.outDir === null
            ? `declares \`${target}\`, which is not there and no tsconfig builds`
            : `declares \`${target}\`, which nothing emits`,
      });
    }
  }
  return problems;
}

function main() {
  const root = process.env["POLARIS_ENTRYPOINT_ROOT"] ?? DEFAULT_ROOT;
  const problems = findUnemittedEntrypoints(root);

  if (problems.length === 0) {
    console.log(
      `declared entrypoints: every path ${String(packageDirs(root).length)} package manifest(s) ` +
        "advertise is emitted by something.",
    );
    return;
  }

  console.error(
    `declared entrypoints: ${String(problems.length)} path(s) a package.json advertises and\n` +
      "nothing emits. An import of one fails at runtime, out of a subpath the package\n" +
      "itself promises.\n",
  );
  for (const problem of problems) {
    console.error(`  ${problem.path}/package.json`);
    console.error(`    ${problem.reason}`);
    if (problem.wanted.length > 0) console.error(`    want ${problem.wanted[0]}`);
    console.error("    -> write the module, or drop the declaration\n");
  }
  process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main();
}
