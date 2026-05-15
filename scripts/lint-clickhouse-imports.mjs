#!/usr/bin/env node
// Polaris ClickHouse import-restriction check.
//
// `@clickhouse/client` is the official ClickHouse JS client. Polaris policy
// (docs/architecture/07-clickhouse.md "Access Control",
//  docs/architecture/09-engineering-standards.md "ClickHouse Access")
// is that **only** `packages/shared-clickhouse/` may import it. Every other
// workspace package must go through that helper, which selects the
// `polaris_service` or `polaris_operator` role and emits a metric on the
// `operator.raw.query` escape hatch.
//
// This script walks the workspace, scans TypeScript/JavaScript source files
// (skipping `node_modules`, `dist`, build output, and test fixtures), and
// fails the build if any file outside the allow-list imports
// `@clickhouse/client` — whether via a static `import`, a dynamic `import()`,
// or `require()`.
//
// Run it as:
//
//   node scripts/lint-clickhouse-imports.mjs
//
// Or, for CI-tailored use, set POLARIS_CLICKHOUSE_LINT_ROOT to scan a
// fixture tree (used by the unit test).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_ROOT = resolve(__dirname, "..");

// Workspace directories that contain runtime/CLI/test source. Aligned with
// pnpm-workspace.yaml and the LOC_DIRS list in the Makefile.
const SCAN_DIRS = ["apps", "packages", "processors", "consumers", "catalog", "scripts"];

// Path prefixes (relative to root) where the official client is *allowed*.
// Anything else is a violation.
const ALLOWED_PATH_PREFIXES = [
  // The shared helper package.
  ["packages", "shared-clickhouse"].join(sep),
];

// File extensions we scan. Skips .json, .md, .yaml, .sql intentionally —
// configuration and prose may name the client without importing it.
const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"]);

// Directories never scanned: build artefacts, dependency installs, fixture
// trees that intentionally contain violation samples.
const IGNORED_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".vitest",
  ".turbo",
  "fixtures",
  "__fixtures__",
]);

const TARGET_SPECIFIER = "@clickhouse/client";

/**
 * Walks `rootDir`, yielding absolute paths of source files under
 * `SCAN_DIRS` that should be linted.
 */
function* iterateSourceFiles(rootDir) {
  for (const top of SCAN_DIRS) {
    const start = join(rootDir, top);
    try {
      statSync(start);
    } catch {
      continue; // Directory may not exist yet (e.g. consumers/, processors/).
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
    if (entry.name.startsWith(".")) continue; // .git, .vitest, etc.
    if (IGNORED_DIR_NAMES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      const idx = entry.name.lastIndexOf(".");
      if (idx === -1) continue;
      const ext = entry.name.slice(idx);
      if (SCANNED_EXTENSIONS.has(ext)) yield full;
    }
  }
}

/**
 * Build a Uint8Array marking which character positions in `source` are
 * "code" (1) vs. inside a string or comment (0). Hand-rolled state
 * machine — not a full parser, but sufficient for distinguishing import
 * statements from documentation comments and string literals.
 *
 * Template-literal interpolation expressions (`${...}`) are treated as
 * code so the rare construct
 *   `import("@clickhouse/${name}")`
 * still flags. That string would not import the real specifier, but
 * any false-positive here is a fix-the-import problem, not a
 * lint-bypass problem.
 */
function classifyPositions(source) {
  const len = source.length;
  const isCode = new Uint8Array(len);
  let i = 0;
  // Mode: 'code' | 'lineComment' | 'blockComment' | 'sq' | 'dq' | 'tpl'
  // Template literals can nest expressions; track depth via tplStack.
  let mode = "code";
  const tplStack = []; // each entry tracks brace depth for the current expression
  let braceDepth = 0;

  while (i < len) {
    const ch = source[i];
    const next = i + 1 < len ? source[i + 1] : "";

    if (mode === "code") {
      isCode[i] = 1;
      if (ch === "/" && next === "/") {
        mode = "lineComment";
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        mode = "blockComment";
        i += 2;
        continue;
      }
      if (ch === "'") {
        mode = "sq";
        i++;
        continue;
      }
      if (ch === '"') {
        mode = "dq";
        i++;
        continue;
      }
      if (ch === "`") {
        mode = "tpl";
        i++;
        continue;
      }
      if (tplStack.length > 0) {
        if (ch === "{") braceDepth++;
        else if (ch === "}") {
          if (braceDepth === 0) {
            // Closing the ${...} expression — return to template.
            mode = "tpl";
            braceDepth = tplStack.pop();
            i++;
            continue;
          }
          braceDepth--;
        }
      }
      i++;
      continue;
    }

    if (mode === "lineComment") {
      if (ch === "\n") {
        mode = "code";
      }
      i++;
      continue;
    }

    if (mode === "blockComment") {
      if (ch === "*" && next === "/") {
        mode = "code";
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (mode === "sq" || mode === "dq") {
      const quote = mode === "sq" ? "'" : '"';
      if (ch === "\\" && i + 1 < len) {
        i += 2;
        continue;
      }
      if (ch === quote) {
        mode = "code";
        i++;
        continue;
      }
      i++;
      continue;
    }

    // mode === "tpl"
    if (ch === "\\" && i + 1 < len) {
      i += 2;
      continue;
    }
    if (ch === "`") {
      mode = "code";
      i++;
      continue;
    }
    if (ch === "$" && next === "{") {
      // Enter expression — push current brace depth and reset.
      tplStack.push(braceDepth);
      braceDepth = 0;
      mode = "code";
      i += 2;
      continue;
    }
    i++;
  }

  return isCode;
}

/**
 * Returns `{ found: boolean, line: number }`. `line` is the 1-based line
 * number of the first occurrence inside an `import` / `require()` /
 * `import()` statement.
 */
export function findClickhouseImport(source) {
  const isCode = classifyPositions(source);

  // Patterns we treat as a violation. Each must start with a recognized
  // import keyword to avoid false positives on unrelated text.
  const patterns = [
    /\b(?:import|export)\b[^;\n]*?from\s*(['"`])(@clickhouse\/client)\1/g,
    /\bimport\s*\(\s*(['"`])(@clickhouse\/client)\1\s*\)/g,
    /\brequire\s*\(\s*(['"`])(@clickhouse\/client)\1\s*\)/g,
    /\bimport\s+(['"`])(@clickhouse\/client)\1/g,
  ];

  for (const re of patterns) {
    re.lastIndex = 0;
    let match = re.exec(source);
    while (match !== null) {
      // Anchor: the keyword (`import`/`export`/`require`) must be in code.
      if (isCode[match.index]) {
        const line = source.slice(0, match.index).split("\n").length;
        return { found: true, line };
      }
      match = re.exec(source);
    }
  }
  return { found: false, line: 0 };
}

function isAllowedPath(relPath) {
  for (const prefix of ALLOWED_PATH_PREFIXES) {
    if (relPath === prefix || relPath.startsWith(prefix + sep)) return true;
  }
  return false;
}

/**
 * Lint a single rootDir. Returns an array of violation objects
 * (`{ file, line }`); empty array means clean.
 */
export function lintWorkspace(rootDir) {
  const violations = [];
  for (const absPath of iterateSourceFiles(rootDir)) {
    const rel = relative(rootDir, absPath);
    if (isAllowedPath(rel)) continue;
    let source;
    try {
      source = readFileSync(absPath, "utf8");
    } catch {
      continue;
    }
    if (!source.includes(TARGET_SPECIFIER)) continue;
    const result = findClickhouseImport(source);
    if (result.found) {
      violations.push({ file: rel, line: result.line });
    }
  }
  return violations;
}

function main() {
  const rootDir = process.env["POLARIS_CLICKHOUSE_LINT_ROOT"]
    ? resolve(process.env["POLARIS_CLICKHOUSE_LINT_ROOT"])
    : DEFAULT_ROOT;

  const violations = lintWorkspace(rootDir);

  if (violations.length === 0) {
    console.log(
      "[lint-clickhouse-imports] no violations. Only packages/shared-clickhouse/ imports @clickhouse/client.",
    );
    return;
  }

  console.error(
    `[lint-clickhouse-imports] ${violations.length} violation(s): @clickhouse/client may only be imported from packages/shared-clickhouse/.`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
  }
  console.error("");
  console.error(
    "  Route the access through @polaris/shared-clickhouse instead. See docs/architecture/07-clickhouse.md 'Access Control'.",
  );
  process.exitCode = 1;
}

// Only run when invoked directly (not when imported by the test).
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main();
}
