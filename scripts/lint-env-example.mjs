/**
 * Every variable `.env.example` documents must be read by something.
 *
 * `lint-process-env` enforces the inverse — a variable READ outside the
 * bootstrap tier fails. Nothing enforced this direction, so `.env.example`
 * accumulated knobs that turn nothing: an operator who sets one gets
 * silence, and concludes the setting had no effect rather than that it
 * was never wired. That is worse than an error, and it is in the file
 * operators trust most.
 *
 * ## What counts as "read"
 *
 * The literal name appearing anywhere in a config schema, service source,
 * script, or compose file. Deliberately broad: the point is to catch
 * variables nothing anywhere mentions, not to police HOW they are read.
 * A name that appears only in `.env.example` and in prose about
 * `.env.example` is the failure.
 *
 * Comments are stripped from BOTH sides. A comment in `.env.example`
 * documenting a variable is not a use of it, and — the case that made
 * this necessary — neither is a comment in source saying the variable is
 * NOT read. `POLARIS_GEOIP_DB_PATH` is named in
 * `sync/legacy/geoip-enricher/v1/src/config.ts` in exactly that sentence,
 * and a scan that took any mention as a use reported it healthy.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, "..");

/** Where a variable may legitimately be read. */
const SEARCH_DIRS = ["apps", "packages", "sync", "async", "catalog", "scripts", "infra", "db"];
// Root files a variable can legitimately be read from.
// matters: a script line like `POLARIS_SMOKE_DOCKER=1 vitest run` is a
// real use, and omitting it reported that variable unread.
const SEARCH_FILES = ["docker-compose.yml", "docker-compose.observability.yml", "package.json"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git"]);
const SEARCH_EXT = new Set([
  ".ts",
  ".mts",
  ".js",
  ".mjs",
  ".cjs",
  ".yml",
  ".yaml",
  ".json",
  ".sql",
]);

/**
 * Variables the file documents.
 *
 * Assignments only (`NAME=value`), not mentions in prose: a comment
 * saying "see also POLARIS_X" is documentation ABOUT a variable, and the
 * thing an operator copies is the assignment.
 */
export function documentedVariables(envExample) {
  const names = new Set();
  for (const raw of envExample.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#") || line.length === 0) continue;
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match !== null) names.add(match[1]);
  }
  return names;
}

function walk(dir, out = []) {
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
    else if (SEARCH_EXT.has(full.slice(full.lastIndexOf(".")))) out.push(full);
  }
  return out;
}

/** One blob of everything a variable could legitimately be read from. */
export function buildHaystack(root = DEFAULT_ROOT) {
  const parts = [];
  for (const dir of SEARCH_DIRS) parts.push(...walk(join(root, dir)));
  for (const file of SEARCH_FILES) {
    try {
      parts.push(join(root, file));
    } catch {
      // Absent in a trimmed checkout; not an error.
    }
  }
  return parts
    .map((file) => {
      try {
        const source = readFileSync(file, "utf8");
        // Only for code: a `#` in YAML or SQL may be inside a value, and
        // over-stripping there would create false FAILURES, which cost
        // more than the false passes they prevent.
        return /\.(ts|mts|js|mjs|cjs)$/.test(file)
          ? source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
          : source;
      } catch {
        return "";
      }
    })
    .join("\n");
}

export function findUnreadVariables(root = DEFAULT_ROOT) {
  const envExample = readFileSync(join(root, ".env.example"), "utf8");
  const haystack = buildHaystack(root);
  return [...documentedVariables(envExample)].filter((name) => !haystack.includes(name)).sort();
}

function main() {
  const unread = findUnreadVariables();
  if (unread.length > 0) {
    console.error(
      `env-example check: ${String(unread.length)} documented variable(s) that nothing`,
    );
    console.error("reads. An operator who sets one gets silence, and concludes the knob had no");
    console.error("effect rather than that it was never wired.\n");
    for (const name of unread) console.error(`  ${name}`);
    console.error("\nWire it, or delete the line and say why in the commit.");
    process.exitCode = 1;
    return;
  }
  console.log("env-example check: every documented variable is read by something.");
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("lint-env-example.mjs")) {
  main();
}
