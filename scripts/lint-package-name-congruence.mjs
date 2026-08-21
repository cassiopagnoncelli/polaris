#!/usr/bin/env node
// Polaris package-name congruence check.
//
// ADR-0007's first law: **libraries group by domain, and "shared" is not a
// domain.** A library's path and its package name must say the same thing:
//
//   libs/<domain>             ->  @polaris/<domain>
//   libs/<domain>/<name>      ->  @polaris/<domain>-<name>
//   sdks/<platform>           ->  @polaris/<platform>
//
// ## Why a check and not a careful rename
//
// The rename this check guards was not a tidy-up. Twenty of the twenty-four
// packages in the flat root ADR-0007 retired wore a `shared-` prefix, and the
// record says what it had come to mean: "not yet categorised". `shared-policy`,
// `shared-schemas`, `shared-transport` and `shared-control-plane` were four
// different architectural layers wearing one badge.
//
// A prefix like that does not arrive in a single bad decision. It accretes,
// one package at a time, because at the moment each package is created the
// prefix is the path of least resistance and nothing objects. That is exactly
// the shape of failure a gate prevents and a sweep does not: IJ4NN can rename
// all twenty-two, and the twenty-third package lands next month named
// whatever its author reached for.
//
// So the congruence is the gate. A new library either sits where its name
// says, or the check names both halves and refuses.
//
// ## What it covers, and what it does not
//
// `libs/` and `sdks/` — the two roots whose names ADR-0007 derives from their
// paths. The other four kinds have their own conventions, and they are
// deliberately NOT checked here:
//
//   - `apps/` names services by role (`@polaris/ingester-api`), which happens
//     to be congruent today. It is not checked because ADR-0007 states the
//     law for `libs/`, and widening a law is an ADR's job, not a lint's.
//   - `sync/` and `async/` name units by pipeline ROLE, not by path:
//     `async/computation/sessionizer/v1` is `@polaris/processor-sessionizer-v1`.
//     A reader looking for the sessionizer processor searches for
//     "processor", and the topology is already in the path.
//   - `definitions/` names registries by contract type: `definitions/traits`
//     is `@polaris/trait-catalog`.
//   - `connectors/` names by family + vendor + version
//     (`connectors/destinations/ga4/v1` is `@polaris/destination-ga4-v1`).
//     Congruent, and unchecked for the same reason as the three above:
//     ADR-0007 states the law for `libs/`, and widening it is an ADR's job.
//     `connectors/README.md` documents the convention.
//
// Checking those here would mean an allowlist with twenty entries in it,
// which is a list nobody reads and a law nobody is enforcing.
//
// Run it as:
//
//   node scripts/lint-package-name-congruence.mjs
//
// Set POLARIS_CONGRUENCE_ROOT to scan a fixture tree (used by the test).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, "..");

const SCOPE = "@polaris/";

/**
 * The roots this law covers, and how deep a package may sit under each.
 *
 * `libs/` allows two levels because a domain may be a single package
 * (`libs/spec`) or a family of them (`libs/persistence/postgres`). `sdks/` is
 * one level: a platform is not a family.
 *
 * A directory with no `package.json` is a grouping directory, not a package —
 * `libs/persistence` holds three packages and is not one itself — so it is
 * walked, never reported.
 */
export const PACKAGE_ROOTS = [
  { root: "libs", maxDepth: 2 },
  { root: "sdks", maxDepth: 1 },
];

/**
 * Congruent-by-exception packages, each with the reason it earns the entry.
 *
 * Keep this SHORT. An entry is a claim that the incongruent name is worth
 * more than the law, and every entry costs a reader the question "why is this
 * one different?" — so the reason has to answer it in a line.
 *
 * `expected` is what congruence WOULD demand; `name` is what the package is
 * actually called. Both are recorded so the entry pins one specific
 * divergence: an allowlisted package that drifts to some THIRD name still
 * fails, which is the difference between an exception and an exemption.
 */
export const ALLOW = new Map([
  [
    "sdks/web",
    {
      name: `${SCOPE}web-sdk`,
      expected: `${SCOPE}web`,
      reason:
        "published to npm and installed by name in other people's codebases; `@polaris/web` would not say it is an SDK",
    },
  ],
  [
    "sdks/node",
    {
      name: `${SCOPE}node-sdk`,
      expected: `${SCOPE}node`,
      reason:
        "published to npm alongside `@polaris/web-sdk`; the pair has to read as a pair (ADR-0003)",
    },
  ],
]);

/** The name `path` must carry, per ADR-0007's first law. */
export function expectedName(path) {
  const [, ...rest] = path.split("/");
  return SCOPE + rest.join("-");
}

/** Every directory holding a package.json under the covered roots. */
function packagePaths(root) {
  const found = [];
  for (const { root: dir, maxDepth } of PACKAGE_ROOTS) {
    const walk = (rel, depth) => {
      let entries;
      try {
        entries = readdirSync(join(root, rel));
      } catch {
        return;
      }
      if (entries.includes("package.json")) {
        found.push({ path: rel, depth });
        return; // a package is a leaf; nested package.json is another matter
      }
      if (depth >= maxDepth) return;
      for (const entry of entries) {
        if (entry.startsWith(".") || entry === "node_modules") continue;
        try {
          if (statSync(join(root, rel, entry)).isDirectory()) walk(`${rel}/${entry}`, depth + 1);
        } catch {
          /* raced with another session's write */
        }
      }
    };
    walk(dir, 0);
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

function readName(root, path) {
  try {
    const manifest = JSON.parse(readFileSync(join(root, path, "package.json"), "utf8"));
    return typeof manifest.name === "string" ? manifest.name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Packages whose name and path disagree.
 *
 * Reports the path, both names and the fix, because a failure here has two
 * legal repairs — rename the package or move the directory — and which one is
 * right is a judgement the check cannot make.
 */
export function findIncongruentNames(root = DEFAULT_ROOT) {
  const problems = [];
  for (const { path } of packagePaths(root)) {
    const name = readName(root, path);
    if (name === undefined) {
      problems.push({ path, reason: "package.json has no `name`", name: null, expected: null });
      continue;
    }
    const allowed = ALLOW.get(path);
    if (allowed !== undefined) {
      if (name !== allowed.name) {
        problems.push({
          path,
          name,
          expected: allowed.name,
          reason: `allowlisted as \`${allowed.name}\` (${allowed.reason}) but is named \`${name}\``,
        });
      }
      continue;
    }
    const expected = expectedName(path);
    if (name !== expected) {
      problems.push({
        path,
        name,
        expected,
        reason: `\`${path}/\` must be \`${expected}\`; move the directory, rename the package, or allowlist it with a reason`,
      });
    }
  }
  return problems;
}

/**
 * Allowlist entries that no longer earn their place.
 *
 * The mirror of the check itself. An exception outlives its reason silently —
 * the package moves, or somebody renames it into congruence — and a stale
 * entry then reads as a live carve-out from the law. Reporting them is what
 * keeps the list short enough to be read.
 */
export function staleAllowlist(root = DEFAULT_ROOT) {
  const stale = [];
  for (const [path, entry] of ALLOW) {
    const name = readName(root, path);
    if (name === undefined) {
      stale.push({ path, reason: "allowlisted but no package.json is there" });
      continue;
    }
    if (name === expectedName(path)) {
      stale.push({
        path,
        reason: `allowlisted as an exception (${entry.reason}) but \`${name}\` is congruent — drop the entry`,
      });
    }
  }
  return stale;
}

function main() {
  const root = process.env["POLARIS_CONGRUENCE_ROOT"] ?? DEFAULT_ROOT;
  const problems = findIncongruentNames(root);
  const stale = staleAllowlist(root);

  if (problems.length === 0 && stale.length === 0) {
    const counted = packagePaths(root).length;
    console.log(
      `package-name congruence: ${String(counted)} package(s) under libs/ and sdks/ are named for ` +
        `their path (${String(ALLOW.size)} allowlisted exception(s)).`,
    );
    return;
  }

  if (problems.length > 0) {
    console.error(
      `package-name congruence: ${String(problems.length)} package(s) whose name and path\n` +
        'disagree. ADR-0007: libraries group by domain, and "shared" is not a domain.\n',
    );
    for (const problem of problems) {
      console.error(`  ${problem.path}/`);
      if (problem.name !== null) console.error(`    is  ${problem.name}`);
      if (problem.expected !== null) console.error(`    want ${problem.expected}`);
      console.error(`    -> ${problem.reason}\n`);
    }
  }
  if (stale.length > 0) {
    console.error("package-name congruence: allowlist entries that no longer earn their place.\n");
    for (const entry of stale) console.error(`  ${entry.path}\n    ${entry.reason}\n`);
  }
  process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main();
}
