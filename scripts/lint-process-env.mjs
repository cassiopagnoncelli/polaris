#!/usr/bin/env node
// Polaris direct-environment-read check.
//
// The project-config programme moves per-project settings out of environment
// variables and into `project_config`, hydrated to services at runtime. The
// value of that is not the table — it is the property that a service CANNOT
// read another project's configuration, because it cannot reach the process
// environment at all from handler code. A property enforced by convention is
// a property that decays: five destination consumers each constructed the env
// secret provider over the raw process environment for months, in a codebase
// whose own doctrine says services must not read the environment directly.
//
// So this check asks: does anything outside the bootstrap tier read the
// environment?
//
//   - The BOOTSTRAP tier legitimately does. A service must know its Postgres
//     DSN and broker URL to reach the store that holds everything else, and
//     that knowledge can only come from the environment. `@polaris/shared-config`
//     owns the reading; a short list of other modules own the reading they
//     genuinely cannot delegate (a logger built before config is parsed, a
//     build stamp, the CLI's own connection resolution).
//   - The SDKs legitimately do. They run inside a customer's process, not a
//     Polaris service, and their environment is that customer's to define.
//   - Everything else must take a frozen `loadEnv()` snapshot, or its slice of
//     project configuration, as an argument.
//
// Comments are stripped before matching. Without that the check flags files
// whose doc comments say "this package never reads process.env" — which is
// both absurd and the fastest way to get a lint disabled.
//
// Run it as:
//
//   node scripts/lint-process-env.mjs
//
// Set POLARIS_PROCESS_ENV_ROOT to scan a fixture tree (used by the unit test).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, "..");

/**
 * Where service code lives.
 *
 * ADR-0007 destinations are listed beside the old roots, both epochs at once
 * the way `pnpm-workspace.yaml` carries both, so each move card is a pure
 * `git mv`. A root matching nothing is a no-op; a root MISSING here silently
 * stops checking everything under it — the platform libraries moved to
 * `libs/` would have left every direct `process.env` read in them unseen.
 *
 * `sdks` earns its line twice over: the SDKs read the environment
 * legitimately and three of their files hold ALLOW entries below. Left off,
 * those entries would read as promises about files nothing scans — the check
 * would report the repository clean without ever opening a published SDK.
 */
const SCAN_DIRS = [
  "apps",
  "packages",
  "sync",
  "async",
  "libs",
  "sdks",
  "connectors",
  "definitions",
];

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git", "__tests__"]);
const SOURCE_EXT = new Set([".ts", ".mts"]);

/**
 * Modules permitted to read the environment directly, each with the reason it
 * cannot delegate.
 *
 * Keep this list SHORT and justified — an entry is a promise that the read is
 * genuinely un-delegatable, not that removing it is inconvenient. Paths are
 * repo-relative and matched exactly.
 *
 * The shape of this list is the programme's progress bar: it started at the
 * whole platform and shrinks as services move onto project configuration.
 */
const ALLOW = new Map([
  // --- the sanctioned reader ---------------------------------------------
  [
    "libs/runtime/config/src/env.ts",
    "loadEnv itself — the one module allowed to touch process.env, by design",
  ],
  [
    "libs/runtime/config/src/loader.ts",
    "resolves the .env cascade and the POLARIS_ENV that selects it, before any config exists",
  ],

  // --- bootstrap that runs before config is parsed -----------------------
  [
    "libs/observability/logger/src/logger.ts",
    "the logger is constructed before config parsing, so it cannot receive a parsed snapshot",
  ],
  [
    "libs/runtime/service-bootstrap/src/bootstrap/build-metadata.ts",
    "build stamps injected by the container build; read once at startup for /health",
  ],
  [
    "libs/tenancy/control-plane/src/resolver.ts",
    "reads POLARIS_TOKEN to resolve the operator actor, which precedes any config load",
  ],

  // --- the CLI: env IS its interface, in the AWS/gh tradition -------------
  [
    "apps/polaris-cli/src/bin/polaris.ts",
    "CLI entrypoint; threads the environment into CommandContext for everything downstream",
  ],
  ["apps/polaris-cli/src/command.ts", "CommandContext construction — the CLI's env seam"],
  ["apps/polaris-cli/src/program.ts", "CLI argv/env wiring at startup"],
  ["apps/polaris-cli/src/config.ts", "resolves ~/.polaris/config.toml and POLARIS_* profile vars"],
  ["apps/polaris-cli/src/db/connect.ts", "CLI's own DATABASE_URL resolution"],
  ["apps/polaris-cli/src/clickhouse/connect.ts", "CLI's own ClickHouse connection resolution"],
  ["apps/polaris-cli/src/catalog/root.ts", "resolves POLARIS_CATALOG_ROOT before any config"],
  ["apps/polaris-cli/src/package-meta.ts", "reads npm_package_* for --version"],
  [
    "apps/polaris-cli/src/commands/journeys/sweep.ts",
    "cron sweep stands in FOR journey-orchestrator: sets that service's own identity " +
      "defaults before calling its config loader, rather than forking a second config path",
  ],

  // --- published SDKs: a customer's process, not a Polaris service -------
  [
    "sdks/node/src/index.ts",
    "published SDK; the host application's environment is its own",
  ],
  ["sdks/web/src/index.ts", "published SDK; bundler-replaced build flag"],
  ["sdks/web/src/sdk.ts", "published SDK; bundler-replaced build flag"],

  // --- known debt --------------------------------------------------------
  // Empty, and worth keeping the heading to say so.
  //
  // Two entries lived here, both reading ClickHouse CONNECTION settings —
  // deployment facts like the Postgres DSN, not per-project values, so neither
  // was waiting on a project-config cutover. They were listed because each
  // bypassed the sanctioned reader. Both are fixed:
  // analytics-projector now composes an optional `clickhouse` section into its
  // config schema instead of parsing `process.env` at the point of use, and
  // clickhouse-sink's loader no longer takes a `processEnv` defaulting to
  // `process.env`.
]);

/**
 * Strip comments so prose about `process.env` is not a violation.
 *
 * Deliberately naive: it does not parse TypeScript, so a `//` inside a string
 * literal truncates that line early. That errs toward MISSING a violation
 * rather than inventing one, which is the right direction for a check whose
 * failure mode is being disabled.
 */
export function stripComments(source) {
  let out = "";
  let i = 0;
  let inLine = false;
  let inBlock = false;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (!inLine && !inBlock && two === "//") {
      inLine = true;
      i += 2;
      continue;
    }
    if (!inLine && !inBlock && two === "/*") {
      inBlock = true;
      i += 2;
      continue;
    }
    if (inLine && source[i] === "\n") {
      inLine = false;
      out += "\n";
      i += 1;
      continue;
    }
    if (inBlock && two === "*/") {
      inBlock = false;
      i += 2;
      continue;
    }
    if (!inLine && !inBlock) out += source[i];
    else if (source[i] === "\n") out += "\n";
    i += 1;
  }
  return out;
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
    else if (SOURCE_EXT.has(entry.slice(entry.lastIndexOf(".")))) out.push(full);
  }
  return out;
}

/** A test's own environment reads are its business. */
function isTestFile(path) {
  return (
    path.includes(`${sep}test${sep}`) ||
    path.includes(`${sep}tests${sep}`) ||
    path.endsWith(".test.ts") ||
    path.endsWith(".spec.ts")
  );
}

export function findDirectEnvReads(root = DEFAULT_ROOT) {
  const violations = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(root, dir))) {
      if (isTestFile(file)) continue;
      const rel = relative(root, file).split(sep).join("/");
      if (ALLOW.has(rel)) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      const lines = code.split("\n");
      for (const [index, line] of lines.entries()) {
        if (line.includes("process.env")) {
          violations.push({ file: rel, line: index + 1, text: line.trim().slice(0, 100) });
        }
      }
    }
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function main() {
  const root = process.env["POLARIS_PROCESS_ENV_ROOT"] ?? DEFAULT_ROOT;
  const violations = findDirectEnvReads(root);

  if (violations.length === 0) {
    console.log(
      `process-env check: no direct reads outside the bootstrap tier (${String(ALLOW.size)} allowed).`,
    );
    return;
  }

  console.error(
    `process-env check: ${String(violations.length)} direct read(s) of process.env outside the\n` +
      "bootstrap tier. A service that can reach the environment can reach another project's\n" +
      "settings; that is the property project configuration exists to make impossible.\n",
  );
  for (const violation of violations) {
    console.error(`  ${violation.file}:${String(violation.line)}  ${violation.text}`);
  }
  console.error(
    "\nTake a frozen `loadEnv()` snapshot or the component's project-config slice as an\n" +
      "argument instead. If the read genuinely cannot be delegated, add the file to ALLOW\n" +
      "in this script with a one-line reason.",
  );
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
