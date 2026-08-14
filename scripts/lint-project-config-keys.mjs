#!/usr/bin/env node
// Polaris project-config key check.
//
// Every key a component declares in its `project-config.ts` becomes operator
// surface: it appears in the admin UI's Variables panel with a typed input, it
// is settable with `polaris config set`, it shows up in `polaris config list`,
// and `polaris config validate` reports on it. All of that happens because the
// key is DECLARED. None of it requires the component to actually READ the key.
//
// So a declared-and-unread key is a control that looks live and is not. An
// operator sets it, sees it stored, sees it in the panel, and nothing changes —
// with no error anywhere, because nothing is wrong except that the wire was
// never connected. meta-capi shipped exactly this: `allow_replay` was declared
// and read by nothing, because replay suppression runs in the destination
// runtime long before the deliverer the config slice is handed to.
//
// This is the same failure family `lint-dead-exports.mjs` exists for — a
// mechanism built, wired, Zod-validated, documented, and read by nobody — but
// no type error and no test catches it, because the key type-checks fine and
// the component's tests only cover what the component reads.
//
// The check: for each namespace in the generator's REGISTRY, every key in its
// generated JSON Schema must appear by name somewhere in the component's `src/`
// OTHER than the declaration module itself.
//
// Run it as:
//
//   node scripts/lint-project-config-keys.mjs
//
// Set POLARIS_PROJECT_CONFIG_ROOT to scan a fixture tree (used by the tests).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { REGISTRY } from "./project-config-schemas-generate.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, "..");

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git"]);
const SOURCE_EXT = new Set([".ts", ".mts", ".tsx"]);

/** The module a key is declared in cannot also be what proves it is read. */
const DECLARATION_BASENAME = "project-config.ts";

/**
 * Keys that are deliberately declared without a direct source reference.
 *
 * Keep this EMPTY if at all possible. A key that a component cannot be shown to
 * read is a key an operator can set to no effect, and the honest fix is almost
 * always to delete the declaration — as meta-capi's `allow_replay` was.
 */
const ALLOW = new Map([]);

/**
 * Keys whose reader is a SHARED package rather than the declaring component.
 *
 * Not an exemption. Each entry names the file that must contain the key, and
 * that file is searched exactly as a component's own `src/` would be — the
 * question "is anything actually reading this?" still has to be answered, it
 * is just asked of the right tree.
 *
 * The distinction this draws is the one `allow_replay` got wrong in the other
 * direction. That key was declared by meta-capi, read by nobody, and looked
 * fine because the reader was ASSUMED to be somewhere shared; the check was
 * built to catch exactly that. But a key genuinely read by shared code is a
 * different case, and refusing it would push authors toward the worse fix —
 * sprinkling a token reference in the consumer to satisfy a grep.
 *
 * A key belongs here only when the shared reader applies it on the
 * component's behalf and the component itself has no business touching it.
 * The routing gate qualifies: it runs inside `processOne`, before the
 * consumer's mapper or deliverer is reached at all.
 */
const SHARED_RUNTIME_READERS = new Map([["routing", "packages/shared-destinations/src/gate.ts"]]);

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
    else if (SOURCE_EXT.has(entry.slice(entry.lastIndexOf(".")))) out.push(full);
  }
  return out;
}

/** `sync/destinations/ga4/v1/dist/project-config.js` -> `sync/destinations/ga4/v1/src`. */
export function sourceDirForDistEntry(distEntry) {
  const parts = distEntry.split("/");
  const distIndex = parts.lastIndexOf("dist");
  if (distIndex === -1) return null;
  return [...parts.slice(0, distIndex), "src"].join("/");
}

/** Declared key names, read from the generated artifact rather than re-parsed. */
export function declaredKeys(schema) {
  const properties = schema?.properties;
  if (properties === null || typeof properties !== "object") return [];
  return Object.keys(properties).sort();
}

/**
 * Which of `keys` no file under `sourceDir` mentions, ignoring the declaration
 * module.
 *
 * A plain substring match, deliberately. A key is snake_case and specific
 * enough that an accidental hit is implausible, and anything cleverer (parsing
 * property accesses) would miss the destructuring and index forms that are
 * perfectly legitimate ways to read one.
 */
export function unreadKeys(keys, files, rootDir = DEFAULT_ROOT) {
  const haystack = files
    .filter((f) => !f.endsWith(`${sep}${DECLARATION_BASENAME}`))
    .map((f) => {
      try {
        return readFileSync(f, "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");
  return keys.filter((key) => {
    const sharedReader = SHARED_RUNTIME_READERS.get(key);
    if (sharedReader !== undefined) {
      // Same question, asked of the declared reader. A stale entry here —
      // pointing at a file that no longer mentions the key — fails exactly
      // as an unread component key does.
      try {
        return !readFileSync(join(rootDir, sharedReader), "utf8").includes(key);
      } catch {
        return true;
      }
    }
    return !haystack.includes(key);
  });
}

function main() {
  const root = process.env["POLARIS_PROJECT_CONFIG_ROOT"] ?? DEFAULT_ROOT;
  const schemaDir = join(root, "packages", "project-config-schemas", "schemas");

  const violations = [];
  let checked = 0;

  for (const entry of REGISTRY) {
    const sourceDir = sourceDirForDistEntry(entry.distEntry);
    if (sourceDir === null) {
      violations.push({
        namespace: entry.namespace,
        key: "(registry)",
        detail: `distEntry "${entry.distEntry}" has no dist/ segment; cannot locate its source`,
      });
      continue;
    }

    let schema;
    try {
      schema = JSON.parse(
        readFileSync(join(schemaDir, `${entry.namespace}.project.schema.json`), "utf8"),
      );
    } catch {
      violations.push({
        namespace: entry.namespace,
        key: "(schema)",
        detail: "no generated schema artifact; run `pnpm config-schemas`",
      });
      continue;
    }

    const keys = declaredKeys(schema);
    const files = walk(join(root, sourceDir));
    if (files.length === 0) {
      violations.push({
        namespace: entry.namespace,
        key: "(source)",
        detail: `no source files under ${sourceDir}`,
      });
      continue;
    }

    for (const key of unreadKeys(keys, files, root)) {
      if (ALLOW.has(`${entry.namespace}::${key}`)) continue;
      violations.push({
        namespace: entry.namespace,
        key,
        detail: `declared but never referenced under ${relative(root, join(root, sourceDir))}`,
      });
    }
    checked += keys.length;
  }

  if (violations.length > 0) {
    console.error(
      `project-config key check: ${String(violations.length)} declared key(s) that nothing reads.\n` +
        "Each is operator surface that changes nothing when set — settable in the admin panel,\n" +
        "visible in `config list`, and inert. Delete the declaration, or wire it up.\n",
    );
    for (const v of violations) {
      console.error(`  ${v.namespace}.${v.key}  ${v.detail}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `project-config key check: ${String(checked)} declared key(s) across ` +
      `${String(REGISTRY.length)} namespace(s), all read by their component.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
