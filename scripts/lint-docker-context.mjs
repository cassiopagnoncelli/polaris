#!/usr/bin/env node
// Polaris build-context check.
//
// No Dockerfile may copy a path that `.dockerignore` prunes from the build
// context. Such a COPY cannot succeed: the file is not in the context, so it
// is not in the image, and `docker build` fails on the instruction.
//
// ## Why a check and not a careful reading
//
// Because the two halves are edited a quarter apart by people solving
// unrelated problems, and neither half is wrong on its own.
//
// `9a5da8d` (2026-05-14) pruned `catalog` from the context as a "local-only
// ops file", which it was: a tree of YAML read by nothing that shipped.
// `5d98d57` (2026-08-14) taught the identity and enrichment images to read
// per-project overrides out of `catalog/projects/`, and added the COPY that
// carries them in. The first commit is still a correct thing to have wanted.
// The second one is too. Together they produce two images that cannot build,
// and nothing said so for six days, because nothing in CI builds an image.
//
// A reader will not catch this. The exclusion is one word on line 68 of a
// file nobody opens, and the COPY is on line 70 of a file in another
// directory. So the pairing is checked instead.
//
// ## What it looks for
//
// Every `COPY`/`ADD` in every Dockerfile, resolved back to the build context:
//
//   1. DIRECT — `COPY catalog/projects /app/...`. The source is a context
//      path. Excluded means broken.
//   2. THROUGH A STAGE — `COPY --from=builder /workspace/catalog/projects
//      /app/...`, where the builder did `WORKDIR /workspace` and `COPY . .`.
//      The path is one indirection from the context and breaks identically.
//      This is the shape the bug had, and a check that only understood the
//      direct form would have reported the repository clean.
//
// A `--from` source with no context provenance — `/deploy`, written by a
// `RUN` — is not checked, because nothing about the context determines
// whether it exists.
//
// ## What it deliberately does not do
//
// It does not verify that a copied path EXISTS. A Dockerfile may legitimately
// copy something generated during the build, and a check that demanded every
// source be on disk would fail on those while catching nothing this one
// misses: the bug is a path the context REFUSES, not a path that is absent.
//
// Run it as:
//
//   node scripts/lint-docker-context.mjs
//
// Set POLARIS_DOCKER_CONTEXT_ROOT to scan a fixture tree (used by the test).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, "..");

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  ".turbo",
  "agents",
]);

// -----------------------------------------------------------------------------
// .dockerignore
// -----------------------------------------------------------------------------

/**
 * Turn one `.dockerignore` pattern into an anchored RegExp.
 *
 * Docker's matcher is `filepath.Match` widened with `**`; the three
 * wildcards are all that appear in this repository's file and all that are
 * translated here. Everything else is escaped, so a pattern containing a `.`
 * or a `+` matches the literal character rather than becoming a regex of its
 * own.
 */
function patternToRegExp(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // `**` crosses separators; `**/` also matches zero directories, so
        // `**/README.md` matches a README at the context root.
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/**
 * Normalise a path RELATIVE TO THE BUILD CONTEXT, the way docker does before
 * matching it against a rule. `/foo`, `./foo` and `foo` are one path here,
 * and the context root is the empty string.
 */
function normalisePath(value) {
  const cleaned = posix
    .normalize(value.replace(/\\/g, "/"))
    .replace(/^\.?\//, "")
    .replace(/\/+$/, "");
  return cleaned === "." ? "" : cleaned;
}

/**
 * Normalise a path INSIDE A STAGE's filesystem, where the leading slash is
 * the difference between `/workspace` and a relative `workspace` and must
 * survive. Kept separate from the context normaliser on purpose: one strips
 * the leading slash and the other cannot.
 */
function normaliseStagePath(value) {
  const cleaned = posix.normalize(value.replace(/\\/g, "/"));
  return cleaned === "/" ? "/" : cleaned.replace(/\/+$/, "");
}

/**
 * Parse `.dockerignore` into ordered rules.
 *
 * Order is the whole semantic: docker applies every rule and the LAST one to
 * match decides, which is what makes `!path` able to re-include something
 * under a broader exclusion.
 */
export function parseDockerignore(source) {
  const rules = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    let text = (lines[i] ?? "").trim();
    if (text === "" || text.startsWith("#")) continue;
    let negated = false;
    if (text.startsWith("!")) {
      negated = true;
      text = text.slice(1).trim();
    }
    const pattern = normalisePath(text);
    if (pattern === "" || pattern === ".") continue;
    rules.push({ pattern, negated, line: i + 1, regexp: patternToRegExp(pattern) });
  }
  return rules;
}

/** Every ancestor of a path, longest last: `a/b/c` -> `a`, `a/b`, `a/b/c`. */
function selfAndAncestors(path) {
  const segments = path.split("/").filter((segment) => segment !== "");
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}

/**
 * Whether the build context excludes `path`, and which rule decided.
 *
 * Excluding a directory prunes everything beneath it, so a path is tested
 * along with each of its ancestors — `catalog/projects` is excluded by the
 * rule `catalog`. Last match wins, ancestors included, which is docker's
 * `MatchesOrParentMatches`.
 */
export function contextStatus(path, rules) {
  const candidates = selfAndAncestors(normalisePath(path));
  let excluded = false;
  let by = null;
  for (const rule of rules) {
    if (!candidates.some((candidate) => rule.regexp.test(candidate))) continue;
    excluded = !rule.negated;
    by = rule;
  }
  return { excluded, by };
}

// -----------------------------------------------------------------------------
// Dockerfiles
// -----------------------------------------------------------------------------

/** Join the physical lines of a Dockerfile, honouring `\` continuations. */
function logicalLines(source) {
  const out = [];
  let buffer = "";
  let start = 0;
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    // A comment inside a continuation is dropped by docker, not appended.
    if (buffer !== "" && trimmed.startsWith("#")) continue;
    if (buffer === "") {
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      start = i + 1;
    }
    if (trimmed.endsWith("\\")) {
      buffer += `${trimmed.slice(0, -1)} `;
      continue;
    }
    out.push({ text: `${buffer}${trimmed}`.trim(), line: start });
    buffer = "";
  }
  if (buffer !== "") out.push({ text: buffer.trim(), line: start });
  return out;
}

/** Resolve a Dockerfile path against the stage's current WORKDIR. */
function resolveInStage(workdir, path) {
  const cleaned = path.replace(/\\/g, "/");
  if (cleaned.startsWith("/")) return normaliseStagePath(cleaned);
  return normaliseStagePath(posix.join(workdir, cleaned));
}

/**
 * @typedef {{stagePath: string, contextPath: string}} Mount
 *   A place the build context was copied into a stage: everything under
 *   `stagePath` in the image came from `contextPath` in the context.
 * @typedef {{
 *   keyword: string, from: string|null, sources: string[], dest: string,
 *   line: number, workdir: string,
 * }} Copy
 * @typedef {{
 *   name: string|null, index: number, image: string,
 *   mounts: Mount[], copies: Copy[],
 * }} Stage
 */

/**
 * Read one Dockerfile into stages, each carrying the COPY/ADD instructions
 * and the places the build context was mounted into its filesystem.
 *
 * A "context mount" is what a `COPY <src> <dest>` without `--from` leaves
 * behind: the knowledge that everything under `<dest>` in this stage came
 * from `<src>` in the context. It is what lets a later
 * `COPY --from=<stage> <path>` be traced back to a context path.
 */
export function parseDockerfile(source) {
  /** @type {Stage[]} */
  const stages = [];
  /** @type {Stage|null} */
  let current = null;
  let workdir = "/";

  for (const { text, line } of logicalLines(source)) {
    const [instruction = ""] = text.split(/\s+/, 1);
    const keyword = instruction.toUpperCase();

    if (keyword === "FROM") {
      const match = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i.exec(text);
      workdir = "/";
      current = {
        name: match?.[2]?.toLowerCase() ?? null,
        index: stages.length,
        image: match?.[1] ?? "",
        mounts: [],
        copies: [],
      };
      stages.push(current);
      continue;
    }
    if (current === null) continue;

    if (keyword === "WORKDIR") {
      const value = text.slice(instruction.length).trim();
      if (value !== "") workdir = resolveInStage(workdir, value) || "/";
      continue;
    }

    if (keyword !== "COPY" && keyword !== "ADD") continue;

    const tokens = text.slice(instruction.length).trim().split(/\s+/).filter(Boolean);
    let from = null;
    const operands = [];
    for (const token of tokens) {
      if (token.startsWith("--")) {
        const fromFlag = /^--from=(.+)$/i.exec(token);
        if (fromFlag?.[1] !== undefined) from = fromFlag[1].toLowerCase();
        continue;
      }
      operands.push(token);
    }
    if (operands.length < 2) continue;

    const dest = operands[operands.length - 1] ?? ".";
    const sources = operands.slice(0, -1);
    current.copies.push({ keyword, from, sources, dest, line, workdir });

    if (from === null) {
      // `COPY <dir> <dest>` puts the CONTENTS of <dir> at <dest>, so the two
      // paths correspond directly.
      for (const src of sources) {
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(src)) continue; // ADD <url>
        if (src.includes("*") || src.includes("?")) continue; // a glob mounts no single tree
        current.mounts.push({
          stagePath: resolveInStage(workdir, dest),
          contextPath: normalisePath(src),
        });
      }
    }
  }
  return stages;
}

/**
 * The context path a `--from` source came from, or null if nothing in the
 * referenced stage traces back to the build context.
 */
function traceToContext(stages, copy) {
  const referenced = stages.find(
    (stage) =>
      stage.name === copy.from || String(stage.index) === copy.from || stage.image === copy.from,
  );
  if (referenced === undefined) return null;

  const source = resolveInStage(copy.workdir, copy.sources[0] ?? "");
  let best = null;
  for (const mount of referenced.mounts) {
    const prefix = mount.stagePath.endsWith("/") ? mount.stagePath : `${mount.stagePath}/`;
    if (source !== mount.stagePath && !source.startsWith(prefix)) continue;
    if (best !== null && mount.stagePath.length <= best.stagePath.length) continue;
    best = mount;
  }
  if (best === null) return null;

  const prefix = best.stagePath.endsWith("/") ? best.stagePath : `${best.stagePath}/`;
  const remainder = source === best.stagePath ? "" : source.slice(prefix.length);
  return normalisePath(posix.join(best.contextPath, remainder));
}

function walk(dir, out = []) {
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
    if (stat.isDirectory()) walk(full, out);
    else if (entry === "Dockerfile" || entry.endsWith(".Dockerfile")) out.push(full);
  }
  return out;
}

/** Every Dockerfile in the tree, repository-relative and sorted. */
export function findDockerfiles(root = DEFAULT_ROOT) {
  return walk(root)
    .map((file) => relative(root, file))
    .sort();
}

/**
 * Every COPY whose source the build context excludes.
 *
 * @returns {Array<{
 *   file: string, line: number, source: string, contextPath: string,
 *   via: string|null, rule: string, ruleLine: number,
 * }>}
 */
export function findExcludedCopies(root = DEFAULT_ROOT) {
  let ignoreSource;
  try {
    ignoreSource = readFileSync(join(root, ".dockerignore"), "utf8");
  } catch {
    return []; // No .dockerignore excludes nothing.
  }
  const rules = parseDockerignore(ignoreSource);
  const problems = [];

  for (const file of findDockerfiles(root)) {
    let stages;
    try {
      stages = parseDockerfile(readFileSync(join(root, file), "utf8"));
    } catch {
      continue;
    }
    for (const stage of stages) {
      for (const copy of stage.copies) {
        for (const src of copy.sources) {
          if (/^[a-z][a-z0-9+.-]*:\/\//i.test(src)) continue;

          let contextPath;
          if (copy.from === null) {
            contextPath = normalisePath(src);
          } else {
            const traced = traceToContext(stages, { ...copy, sources: [src] });
            if (traced === null) continue;
            contextPath = traced;
          }
          // A glob is checked at the deepest literal directory above it: if
          // that is pruned, every match of the glob is pruned with it.
          const wildcard = contextPath.search(/[*?]/);
          if (wildcard !== -1) {
            const cut = contextPath.lastIndexOf("/", wildcard);
            if (cut <= 0) continue;
            contextPath = contextPath.slice(0, cut);
          }
          if (contextPath === "" || contextPath === ".") continue;

          const { excluded, by } = contextStatus(contextPath, rules);
          if (!excluded || by === null) continue;
          problems.push({
            file,
            line: copy.line,
            source: src,
            contextPath,
            via: copy.from,
            rule: by.pattern,
            ruleLine: by.line,
          });
        }
      }
    }
  }
  return problems;
}

function main() {
  const root = process.env["POLARIS_DOCKER_CONTEXT_ROOT"] ?? DEFAULT_ROOT;
  const problems = findExcludedCopies(root);
  const count = findDockerfiles(root).length;

  if (problems.length === 0) {
    console.log(
      `docker-context check: every COPY in ${String(count)} Dockerfile(s) names a path the ` +
        "build context carries.",
    );
    return;
  }

  console.error(
    `docker-context check: ${String(problems.length)} COPY instruction(s) name a path that\n` +
      ".dockerignore prunes from the build context. These builds cannot succeed.\n",
  );
  for (const problem of problems) {
    const through = problem.via === null ? "" : ` (via --from=${problem.via})`;
    console.error(`  ${problem.file}:${String(problem.line)}`);
    console.error(`    COPY${through} ${problem.source}`);
    console.error(
      `    -> resolves to \`${problem.contextPath}\` in the build context, which ` +
        `.dockerignore:${String(problem.ruleLine)} excludes with \`${problem.rule}\`\n`,
    );
  }
  console.error(
    "Fix the pair, not one side: either the path belongs in the image (drop or\n" +
      "narrow the .dockerignore rule) or it does not (drop the COPY).\n",
  );
  process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main();
}
