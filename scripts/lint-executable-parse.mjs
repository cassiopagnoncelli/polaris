#!/usr/bin/env node
// Polaris executable-parse check.
//
// Every tracked executable file parses under the interpreter its shebang
// names. That is the whole rule, and it is the floor: not style, not types,
// not whether the thing works — whether the interpreter can read it at all.
//
// ## Why a check, when three gates already read this repository
//
// Because none of them reads these files. `make dev` was `bin/dev`, `bin/dev`
// had been a SyntaxError since the T0 move, and it stayed one for days on a
// repository whose lint, typecheck and test suite were all green:
//
//   - `biome lint .` does not process an extensionless path. Point it at one
//     and it answers "Checked 0 files"; sweep the repository and it says
//     nothing at all, because the file was never in the set.
//   - `typecheck` loads what is imported. Nothing imports `bin/dev`.
//   - no test runs it.
//
// So the file was reached only by a person typing `make dev`, and the first
// thing that read it was them. The fault itself was ordinary — a JSDoc block
// naming the two-segment library root as a literal glob, which contains the
// block-comment terminator, so the comment ended ninety lines early and the
// prose after it became code.
//
// The instance was one comment. The class is every file the toolchain cannot
// see: extensionless scripts, shell scripts, anything reached by being run
// rather than by being imported. This checks the class.
//
// ## Tracked and executable, from the index
//
// The file set is `git ls-files -s` filtered to mode 100755 — the mode in the
// INDEX, not on disk. That is deliberate: the index mode is what a fresh
// checkout gets and what CI runs, so a local `chmod +x` that was never staged
// is correctly none of this check's business, and a file staged executable is
// its business even if somebody has since cleared the bit locally.
//
// `agents/*/bin/*` is out of scope and falls out for free — that tree is
// gitignored, so it is not in the index to begin with.
//
// ## Why not `node --check <path>`
//
// Because it passes on the very fault this check exists to catch, and does it
// quietly. `node --check` picks a parser from the path: extension first, then
// the nearest package.json `type`. Where neither settles it — an extensionless
// file, or a `.js` one, under a manifest declaring no `type` — node falls back
// to detecting the format from the source, and the detection is what goes
// wrong. It compiles as CommonJS, reaches the first `import`, reads that as
// "this is a module", and returns. Nothing then parses it as a module. So
// every syntax error BELOW the file's first import statement is invisible to
// it: exit 0 on a file that is a SyntaxError under both parsers.
//
// That is not a corner of the behaviour, it is the middle of it. `bin/dev`
// imports at line 43 and broke at line 97, and the command was measured on
// that exact file: exit 1 under this repository's root `"type": "module"`,
// exit 0 with that one field removed. Move the break above the first import
// and the same command goes red — which is what makes the hole easy to miss
// and easy to "verify" your way past.
//
// A gate that depends on a manifest field it does not own is a gate one edit
// from blind, and this repository has already paid for that shape more than
// once. So the format is resolved HERE, by the rules below, and the source is
// handed to node on stdin with an explicit `--input-type` — on stdin, because
// handing it a path is what lets node go back to guessing. Where the rules run
// out, both parsers are tried and the file passes if either accepts it: node's
// own detection minus the early return. A file either parser accepts is a file
// node will run, and a file neither accepts is reported by the module parse,
// which is the message running it would print.
//
// ## What it does not check
//
// Style, types, whether the script does what it says. Parsing is the floor.
// The one thing above the floor it does assert is that an executable declares
// an interpreter this check can actually run: an unrecognised shebang is a
// failure, not a skip, because a check that quietly ignores what it does not
// recognise turns itself off for everything written after it.
//
// Run it as:
//
//   node scripts/lint-executable-parse.mjs
//
// Set POLARIS_EXECUTABLE_PARSE_ROOT to scan a fixture tree (used by the test).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, "..");

/** The git index mode that means "regular file, executable". */
export const EXECUTABLE_MODE = "100755";

/**
 * Interpreters this check knows how to ask for a parse-only verdict.
 *
 * Keyed by the basename the shebang resolves to. A name that is not here is
 * reported rather than skipped — see the header.
 */
export const KNOWN_INTERPRETERS = ["node", "bash", "sh", "zsh"];

/**
 * The interpreter a shebang names, or `null` when there is no shebang.
 *
 * Handles the `env` forms this repository actually uses and the `env -S`
 * form it does not yet: `env` is a launcher, so the interpreter is the first
 * argument that is neither one of its options nor a `VAR=value` assignment.
 *
 * @param {string} source
 * @returns {string | null}
 */
export function shebangInterpreter(source) {
  const firstLine = source.split("\n", 1)[0] ?? "";
  if (!firstLine.startsWith("#!")) return null;

  const tokens = firstLine.slice(2).trim().split(/\s+/).filter(Boolean);
  let head = tokens.shift();
  if (head === undefined) return null;

  if (basename(head) === "env") {
    while (tokens.length > 0) {
      const next = tokens[0];
      if (next === undefined) break;
      // `env -S "node --flag"` splits the rest itself; `env FOO=bar node`
      // sets a variable first. Neither is the interpreter.
      if (next.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(next)) {
        tokens.shift();
        continue;
      }
      break;
    }
    head = tokens.shift();
    if (head === undefined) return null;
  }
  return basename(head);
}

/** The last path segment, without pulling in `path` for a shebang word. */
function basename(word) {
  const cut = word.lastIndexOf("/");
  return cut === -1 ? word : word.slice(cut + 1);
}

/**
 * The `type` the nearest package.json declares for a file, or `null`.
 *
 * Walks from the file's directory up to `root` inclusive, which is the same
 * lookup node performs — stated here rather than borrowed, because the point
 * of doing it ourselves is not depending on node's version of it.
 *
 * @returns {"module" | "commonjs" | null}
 */
export function nearestPackageType(root, file) {
  let dir = dirname(resolve(root, file));
  const stop = resolve(root);
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      const declared = manifest.type;
      if (declared === "module" || declared === "commonjs") return declared;
      return null;
    } catch {
      // No manifest here, or one that cannot be read. Keep walking: an
      // unreadable manifest is a different defect with a different gate.
    }
    if (dir === stop) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The `--input-type` values to try for a node script, in order.
 *
 * One entry when the tree settles the question, two when it does not. Two is
 * not indecision: node itself parses such a file as CommonJS and falls back
 * to module when it sees module syntax, so a file that either parser accepts
 * is a file node will run.
 *
 * @returns {string[]}
 */
export function nodeParseFormats(root, file) {
  const ext = extname(file);
  if (ext === ".mjs") return ["module"];
  if (ext === ".cjs") return ["commonjs"];
  const declared = nearestPackageType(root, file);
  if (declared === "module") return ["module"];
  if (declared === "commonjs") return ["commonjs"];
  return ["commonjs", "module"];
}

/**
 * The interpreter's complaint, cut down to the part about the file.
 *
 * Node prints the offending line, the caret, the error, then six frames of
 * its own internals and a version banner. The frames are about node's parser,
 * not about the script, and a reader scanning a failure list for a filename
 * and a line number should not have to step over them. `[stdin]` becomes the
 * real path, because the source was handed over on stdin and node has no
 * other name for it.
 */
function cleanError(err, file) {
  const stderr = String(err?.stderr ?? "").trim();
  const text = stderr.length > 0 ? stderr : String(err?.message ?? "unknown error").trim();
  const lines = [];
  for (const line of text.split("\n")) {
    if (/^\s*at\s/.test(line)) continue;
    if (/^Node\.js v/.test(line)) continue;
    lines.push(line);
  }
  return lines.join("\n").trim().replaceAll("[stdin]", file);
}

/**
 * Ask node whether the source parses, without letting it guess the format.
 *
 * The source goes in on stdin so `--input-type` is what decides, and the
 * check runs under `process.execPath` — the node already running this file —
 * so the verdict is not a claim about whichever node happens to be on PATH.
 */
function checkNode(root, file, source) {
  const attempts = nodeParseFormats(root, file);
  let last = null;
  for (const format of attempts) {
    try {
      execFileSync(process.execPath, [`--input-type=${format}`, "--check"], {
        input: source,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return null;
    } catch (err) {
      last = err;
    }
  }
  // The last attempt's error, because the attempts run least-permissive
  // first: where both were tried, the module parse is the one whose message
  // describes what running the file would print.
  return `node could not parse it:\n${indent(cleanError(last, file))}`;
}

/** Ask a shell for a syntax-only verdict on the file. */
function checkShell(interpreter, root, file) {
  try {
    execFileSync(interpreter, ["-n", resolve(root, file)], { stdio: ["ignore", "pipe", "pipe"] });
    return null;
  } catch (err) {
    if (err?.code === "ENOENT") {
      return (
        `its shebang names \`${interpreter}\`, which is not on PATH, so nothing checked ` +
        "its syntax. Install it, or point the shebang at an interpreter that is here."
      );
    }
    return `${interpreter} could not parse it:\n${indent(cleanError(err, file))}`;
  }
}

function indent(text) {
  return text
    .split("\n")
    .map((line) => `       ${line}`)
    .join("\n");
}

/**
 * Why a tracked executable is not acceptable, or `null` when it is.
 *
 * @returns {string | null}
 */
export function parseProblem(root, file) {
  let source;
  try {
    source = readFileSync(resolve(root, file), "utf8");
  } catch (err) {
    return `is tracked executable but could not be read: ${err.message}`;
  }

  const interpreter = shebangInterpreter(source);
  if (interpreter === null) {
    return (
      "carries the executable bit but no `#!` line, so nothing says how to run it " +
      "and nothing can check that it parses. Add a shebang, or `git update-index " +
      `--chmod=-x ${file}\` if it is not meant to be run.`
    );
  }

  if (interpreter === "node") return checkNode(root, file, source);
  if (interpreter === "bash" || interpreter === "sh" || interpreter === "zsh") {
    return checkShell(interpreter, root, file);
  }

  return (
    `runs under \`${interpreter}\`, which this check cannot ask for a parse-only ` +
    `verdict — it knows ${KNOWN_INTERPRETERS.join(", ")}. Teach it that interpreter in ` +
    "`scripts/lint-executable-parse.mjs`, so the file is checked rather than skipped."
  );
}

/**
 * Every path the git index carries as an executable regular file.
 *
 * Sorted, so a failure list reads the same on every machine.
 *
 * @returns {string[]}
 */
export function trackedExecutables(root = DEFAULT_ROOT) {
  let listing;
  try {
    listing = execFileSync("git", ["ls-files", "-s", "-z"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of listing.split("\0")) {
    if (entry.length === 0) continue;
    // `<mode> <sha> <stage>\t<path>` — the path may contain spaces, the three
    // fields before the tab may not.
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    if (!entry.startsWith(`${EXECUTABLE_MODE} `)) continue;
    files.push(entry.slice(tab + 1));
  }
  return files.sort();
}

/**
 * Everything wrong with the tracked executables of a tree.
 *
 * `files` is injectable so the law can be tested against a fixture directory,
 * which has no git index to be listed from.
 *
 * @returns {Array<{ where: string, reason: string }>}
 */
export function findParseProblems(root = DEFAULT_ROOT, files = trackedExecutables(root)) {
  const problems = [];
  for (const file of files) {
    const reason = parseProblem(root, file);
    if (reason !== null) problems.push({ where: file, reason });
  }
  return problems;
}

/** How many executables each interpreter accounts for, for the success line. */
function census(root, files) {
  const counts = new Map();
  for (const file of files) {
    let interpreter;
    try {
      interpreter = shebangInterpreter(readFileSync(resolve(root, file), "utf8")) ?? "?";
    } catch {
      interpreter = "?";
    }
    counts.set(interpreter, (counts.get(interpreter) ?? 0) + 1);
  }
  return [...counts]
    .sort()
    .map(([name, count]) => `${name}: ${String(count)}`)
    .join(", ");
}

function main() {
  const root = process.env["POLARIS_EXECUTABLE_PARSE_ROOT"] ?? DEFAULT_ROOT;
  const files = trackedExecutables(root);

  // A file set of zero satisfies every assertion below it. `bin/dev` was
  // invisible to three gates for exactly this reason -- none of them reported
  // it clean, they reported nothing about it -- so an empty scan is a failure
  // here rather than a green run over nothing.
  if (files.length === 0) {
    console.error(
      "executable parse: the git index lists no executable files, so this check read\n" +
        "nothing. Either `git ls-files` failed, or the executable bits are gone from the\n" +
        "index -- `git ls-files -s | grep ^100755` says which.",
    );
    process.exitCode = 1;
    return;
  }

  const problems = findParseProblems(root, files);

  if (problems.length === 0) {
    console.log(
      `executable parse: ${String(files.length)} tracked executable(s) parse under the ` +
        `interpreter their shebang names (${census(root, files)}).`,
    );
    return;
  }

  console.error(
    `executable parse: ${String(problems.length)} of ${String(files.length)} tracked ` +
      "executable(s) cannot be read by the interpreter that runs them.\n" +
      "Nothing else in this repository opens these files: they carry no extension the\n" +
      "linter processes, nothing imports them, and no test runs them.\n",
  );
  for (const problem of problems) {
    console.error(`  ${problem.where}`);
    console.error(`    -> ${problem.reason}\n`);
  }
  process.exitCode = 1;
}

if (process.argv[1]?.endsWith("lint-executable-parse.mjs")) {
  main();
}
