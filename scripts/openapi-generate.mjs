#!/usr/bin/env node
/**
 * Polaris OpenAPI generator.
 *
 * Reads the Zod sources via the ingester's `buildOpenApiDocument` helper
 * and writes the result to `docs/api/openapi.yaml` and `docs/api/openapi.json`.
 *
 * The committed YAML is the source-of-truth published doc. CI diffs the
 * regenerated YAML against the committed copy; a mismatch fails the build
 * with a hint to re-run this script.
 *
 * Usage:
 *
 *   pnpm openapi              # write docs/api/openapi.{yaml,json}
 *   pnpm openapi:check        # re-run and diff against the committed file
 *
 * Or, programmatically:
 *
 *   node scripts/openapi-generate.mjs [--check] [--out <path>]
 *
 * Exit codes:
 *   0   success / no drift
 *   1   drift detected (in --check) or generation failure
 *
 * Polaris hard-rule: the script imports the ingester package, which means
 * `pnpm build` must run first (the workspace has a `build` script that
 * compiles every package to `dist/`). The CI pipeline already builds
 * before running tests; the wrapper script gives a friendly message if
 * the dist tree is missing.
 *
 * @see docs/architecture/09-engineering-standards.md "OpenAPI"
 * @see docs/api/README.md
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { stringify as yamlStringify } from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

const DEFAULT_OUT_YAML = resolve(REPO_ROOT, "docs", "api", "openapi.yaml");
const DEFAULT_OUT_JSON = resolve(REPO_ROOT, "docs", "api", "openapi.json");

const INGESTER_DIST_ENTRY = resolve(REPO_ROOT, "apps", "ingester-api", "dist", "index.js");
const INGESTER_SRC_ENTRY = resolve(REPO_ROOT, "apps", "ingester-api", "src", "index.ts");

/**
 * Pretty-print mode used for the JSON document. We commit both YAML
 * (human-friendly diffs, the dominant OpenAPI ecosystem format) and JSON
 * (tooling like Redocly CLI sometimes prefers it). The JSON uses 2-space
 * indentation and a trailing newline so Biome's JSON formatter does not
 * fight us.
 */
const JSON_INDENT = 2;

/**
 * Build the OpenAPI document by importing the ingester. We use a dynamic
 * import because Node ESM cannot statically resolve a workspace path,
 * and because the script must be runnable from any cwd.
 */
async function loadDocument() {
  // We need to import via the package entry-point, not the dist path
  // directly, so workspace resolution does the right thing. But the dist
  // tree must exist (we don't ship a runtime TS compiler). Be explicit
  // about that in error messages.
  if (!existsSync(INGESTER_DIST_ENTRY)) {
    const hasSrc = existsSync(INGESTER_SRC_ENTRY);
    throw new Error(
      [
        "ingester-api dist/ is missing — cannot generate OpenAPI document.",
        hasSrc
          ? "Run `pnpm build` first; the generator imports compiled JS only."
          : "ingester-api/src/index.ts is also missing; check the worktree layout.",
        `Looked at: ${INGESTER_DIST_ENTRY}`,
      ].join("\n"),
    );
  }
  /** @type {import("../apps/ingester-api/dist/index.js")} */
  const mod = await import(INGESTER_DIST_ENTRY);
  const { buildOpenApiDocument, PUBLISHED_OPENAPI_INFO, PUBLISHED_OPENAPI_SERVERS } = mod;
  if (typeof buildOpenApiDocument !== "function") {
    throw new Error(
      "ingester-api exports lack `buildOpenApiDocument`; check that the OpenAPI module is wired into the package barrel.",
    );
  }
  const doc = buildOpenApiDocument({
    info: PUBLISHED_OPENAPI_INFO,
    servers: PUBLISHED_OPENAPI_SERVERS,
  });
  return doc;
}

/**
 * Serialize the document to YAML and JSON strings. Kept pure so unit
 * tests can re-use it.
 */
export function serialize(document) {
  const yaml = yamlStringify(document, {
    // The YAML spec lets us use either style. We pick `block` because it
    // gives the cleanest line-based diffs, which is the whole point of
    // committing the YAML file.
    defaultStringType: "QUOTE_DOUBLE",
    defaultKeyType: "PLAIN",
    lineWidth: 0,
    minContentWidth: 0,
    // Disable YAML anchor/alias output. Repeated example payloads are
    // expanded in-place so every OpenAPI renderer (Redocly, Swagger UI,
    // VSCode YAML preview) handles the file without needing alias
    // resolution.
    aliasDuplicateObjects: false,
  });
  const json = `${JSON.stringify(document, null, JSON_INDENT)}\n`;
  return { yaml, json };
}

/**
 * Parse `process.argv` minimally. We avoid bringing in a flag-parsing
 * library — the surface is tiny.
 */
function parseArgs(argv) {
  const args = { check: false, yamlOut: DEFAULT_OUT_YAML, jsonOut: DEFAULT_OUT_JSON };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") {
      args.check = true;
    } else if (arg === "--out") {
      const next = argv[i + 1];
      if (next === undefined) throw new Error("--out requires a path argument");
      args.yamlOut = resolve(next);
      args.jsonOut = args.yamlOut.replace(/\.ya?ml$/i, ".json");
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: node scripts/openapi-generate.mjs [--check] [--out <path>]",
          "",
          "  --check   Re-run generation and diff against the committed file. Exits",
          "            non-zero on drift; useful in CI.",
          "  --out     Write YAML to <path> (and .json next to it). Defaults to",
          "            docs/api/openapi.yaml.",
          "",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function ensureDir(filepath) {
  mkdirSync(dirname(filepath), { recursive: true });
}

function readIfExists(path) {
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf8");
}

async function main() {
  const args = parseArgs(process.argv);
  const doc = await loadDocument();
  const { yaml, json } = serialize(doc);

  if (args.check) {
    const yamlExisting = readIfExists(args.yamlOut);
    const jsonExisting = readIfExists(args.jsonOut);

    const drifts = [];
    if (yamlExisting !== yaml) {
      drifts.push({ path: args.yamlOut, expected: yaml, actual: yamlExisting ?? "(missing)" });
    }
    if (jsonExisting !== json) {
      drifts.push({ path: args.jsonOut, expected: json, actual: jsonExisting ?? "(missing)" });
    }
    if (drifts.length > 0) {
      process.stderr.write(
        [
          "OpenAPI drift detected. Re-run `pnpm openapi` and commit the result.",
          "",
          ...drifts.map((d) => `  drifted: ${d.path}`),
          "",
        ].join("\n"),
      );
      process.exit(1);
    }
    process.stdout.write(`OpenAPI in sync: ${args.yamlOut}\n`);
    return;
  }

  ensureDir(args.yamlOut);
  ensureDir(args.jsonOut);
  writeFileSync(args.yamlOut, yaml, "utf8");
  writeFileSync(args.jsonOut, json, "utf8");
  process.stdout.write(`Wrote ${args.yamlOut}\nWrote ${args.jsonOut}\n`);
}

// Allow the script to be imported by tests without running main().
const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

export { loadDocument };
