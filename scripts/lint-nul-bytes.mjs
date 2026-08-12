#!/usr/bin/env node
// Polaris raw-NUL-byte check.
//
// A text source file that contains a raw NUL byte is "binary" to the tools we
// read code with, and both of them fail quietly:
//
//   - ripgrep SKIPS binary files during recursive search. It prints no
//     warning, and the exit code is the same as a genuine no-match, so the
//     file simply stops appearing in repo-wide results.
//   - git renders its diffs as "Bin 9450 -> 9851 bytes" instead of reviewable
//     text, so changes to it cannot be read in review.
//
// Polaris hit this for real. `apps/control-plane-api/src/admin/pages/processors.ts`
// and `packages/shared-processor/src/activation-gate.ts` each built a
// composite Map key with a NUL separator written as the byte itself; both
// files were invisible to every `rg` search until someone noticed by accident.
//
// NUL as a *separator* is correct — it is the one character an identifier
// cannot contain, so joined keys cannot collide. Writing it as the raw byte
// is what breaks the tooling. The Unicode escape is the identical string at
// runtime and leaves the file as plain text.
//
// Run it as:
//
//   node scripts/lint-nul-bytes.mjs
//
// Set POLARIS_NUL_LINT_ROOT to scan a fixture tree instead (used by the test).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_ROOT = resolve(__dirname, "..");

// Built rather than written literally: a source file describing this rule
// must not contain the very sequence tool input decodes into a raw NUL.
const ESCAPE_FORM = `${String.fromCharCode(92)}u0000`;

// Directories holding text we read with grep. Broader than the ClickHouse
// import lint's list, because a NUL is just as damaging in a migration or a
// design doc as in a .ts file.
const SCAN_DIRS = [
  "apps",
  "packages",
  "processors",
  "consumers",
  "catalog",
  "scripts",
  "sql",
  "db",
  "docs",
  "tests",
];

// An allow-list, not a deny-list. Every extension here is text by definition,
// so a real binary checked into the tree can never trip this check — the cost
// is that a NUL in an unlisted text format goes unnoticed, which is the safer
// way to be wrong for something wired into `pnpm lint`.
const SCANNED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".json",
  ".jsonc",
  ".sql",
  ".yaml",
  ".yml",
  ".md",
  ".css",
  ".html",
  ".sh",
  ".toml",
  ".env",
  ".txt",
]);

const IGNORED_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".vitest",
  ".turbo",
]);

function* iterateSourceFiles(rootDir) {
  for (const top of SCAN_DIRS) {
    const start = join(rootDir, top);
    try {
      statSync(start);
    } catch {
      continue; // Directory may not exist in a fixture tree.
    }
    yield* walk(start);
  }
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (IGNORED_DIR_NAMES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      const idx = entry.name.lastIndexOf(".");
      if (idx === -1) continue;
      if (SCANNED_EXTENSIONS.has(entry.name.slice(idx))) yield full;
    }
  }
}

/**
 * Locate every raw NUL in a buffer.
 *
 * Takes a Buffer rather than a string on purpose: decoding to UTF-8 first
 * would let a lone NUL survive as U+0000 anyway, but reading bytes keeps the
 * reported offset honest for files with multi-byte characters.
 *
 * Returns `[{ line, offset }]`, 1-based lines, empty when clean.
 */
export function findNulBytes(buffer) {
  const hits = [];
  let line = 1;
  for (let i = 0; i < buffer.length; i += 1) {
    const byte = buffer[i];
    if (byte === 0x0a) line += 1;
    else if (byte === 0) hits.push({ line, offset: i });
  }
  return hits;
}

/**
 * Lint a single rootDir. Returns `[{ file, line, offset }]`; empty is clean.
 */
export function lintWorkspace(rootDir) {
  const violations = [];
  for (const absPath of iterateSourceFiles(rootDir)) {
    let buffer;
    try {
      buffer = readFileSync(absPath);
    } catch {
      continue;
    }
    // indexOf first: the overwhelming majority of files are clean, and this
    // avoids a per-byte loop over the whole repository.
    if (buffer.indexOf(0) === -1) continue;
    const rel = relative(rootDir, absPath);
    for (const hit of findNulBytes(buffer)) {
      violations.push({ file: rel, line: hit.line, offset: hit.offset });
    }
  }
  return violations;
}

function main() {
  const rootDir = process.env["POLARIS_NUL_LINT_ROOT"]
    ? resolve(process.env["POLARIS_NUL_LINT_ROOT"])
    : DEFAULT_ROOT;

  const violations = lintWorkspace(rootDir);

  if (violations.length === 0) {
    console.log("[lint-nul-bytes] no raw NUL bytes in tracked text sources.");
    return;
  }

  console.error(
    `[lint-nul-bytes] ${violations.length} raw NUL byte(s) found. ripgrep skips these files silently on any recursive search, and git cannot diff them as text.`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} (byte offset ${v.offset})`);
  }
  console.error("");
  console.error(
    `  Write the character as the ${ESCAPE_FORM} escape instead of the byte. It is the identical string at runtime and leaves the file greppable.`,
  );
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main();
}
