#!/usr/bin/env node
// Polaris blueprint link check.
//
// A blueprint depends on Polaris the way a customer would — by local path,
// never by `workspace:*`:
//
//   "@polaris/node-sdk": "link:../../sdks/node"
//
// That property is the point of the tier: a blueprint proves the SDKs are
// usable from outside the monorepo, which it could not prove if it resolved
// internals through workspace membership. It is also what makes the tier
// fragile in a way nothing else in this repository is.
//
// ## Why a check and not a careful move
//
// ADR-0007 moved the two SDKs to `sdks/`. ZXBDY updated the blueprint's
// manifest to the new paths and the T0 gate went green — because nothing in
// it ever looked. `blueprints/` is outside `pnpm-workspace.yaml` on purpose,
// so a root `pnpm install` does not reach it; it is outside
// `tsconfig.tests.json`, so no typecheck reaches it; and it was outside every
// `SCAN_DIRS` list in this directory. The whole tier was invisible to the
// restructure that moved the packages it depends on, and the breakage was
// found by running the app rather than by any gate.
//
// The silence is structural, not an oversight. A dangling `link:` is not a
// resolution error at install time — pnpm records the link and carries on —
// so the failure lands later, as a module-not-found from Next, on whoever
// next opens the blueprint. A workspace member cannot fail this way: pnpm
// resolves it by NAME, so the twenty-four packages ADR-0007 moved were
// followed without anyone editing a path. The blueprint pays for its
// independence with a hard-coded one, and this is the check that makes the
// repository pay attention to it.
//
// ## What it checks
//
// Every local-path dependency a blueprint declares — `link:` and `file:`, the
// two specifiers that name a directory instead of a registry version:
//
//   1. the target EXISTS, and is a directory;
//   2. it is a package, id est it holds a readable package.json;
//   3. that package.json's `name` is the name the blueprint imports it by.
//
// (3) is what makes this more than a stat(). A move that leaves something
// else at the old path yields a link that resolves and an app that imports
// the wrong code — the same silence as a missing directory, and harder to
// read once somebody does look.
//
// ## What it deliberately does not check
//
// The blueprint's `pnpm-lock.yaml` and `node_modules/`, which are gitignored.
// A rule over them could never fire in CI, where neither file exists, and
// `pnpm install --ignore-workspace` rebuilds both from the manifest anyway.
// The manifest is the tracked surface, so the manifest is the gate.
//
// Nor does it build the target: whether `sdks/node/dist` exists is a
// build-order question about generated output, not a question about the link.
//
// Run it as:
//
//   node scripts/lint-blueprint-links.mjs
//
// Set POLARIS_BLUEPRINT_ROOT to scan a fixture tree (used by the test).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, "..");

/** Where the tier lives. One level deep: a blueprint is an app, not a family. */
export const BLUEPRINT_ROOT = "blueprints";

/**
 * The specifier prefixes that name a path on disk.
 *
 * `link:` is the form the tier uses. `file:` is listed because it breaks
 * identically on a move and nothing stops somebody reaching for it — a gate
 * that covered only the form in use today would be silent on the form that
 * arrives tomorrow.
 */
export const PATH_PREFIXES = ["link:", "file:"];

/** The manifest fields a dependency can be declared in. */
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

/** The local-path dependencies a manifest declares. Pure, so the law is testable. */
export function linksIn(manifest) {
  const links = [];
  for (const field of DEPENDENCY_FIELDS) {
    const declared = manifest?.[field];
    if (typeof declared !== "object" || declared === null) continue;
    for (const [name, specifier] of Object.entries(declared)) {
      if (typeof specifier !== "string") continue;
      const prefix = PATH_PREFIXES.find((candidate) => specifier.startsWith(candidate));
      if (prefix === undefined) continue;
      links.push({ name, field, specifier, target: specifier.slice(prefix.length) });
    }
  }
  return links;
}

/** Every blueprint directory holding a package.json. */
export function blueprintPaths(root = DEFAULT_ROOT) {
  let entries;
  try {
    entries = readdirSync(join(root, BLUEPRINT_ROOT));
  } catch {
    return []; // the tier is absent, which is not this check's business
  }
  const found = [];
  for (const entry of entries.sort()) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const path = `${BLUEPRINT_ROOT}/${entry}`;
    try {
      if (!statSync(join(root, path)).isDirectory()) continue;
      if (!statSync(join(root, path, "package.json")).isFile()) continue;
    } catch {
      continue; // a directory without a manifest is prose, not a blueprint
    }
    found.push(path);
  }
  return found;
}

/**
 * Every declared local-path dependency in the tier, and every manifest that
 * could not be read.
 *
 * One reader for both, so the count this check reports and the set it
 * verifies can never disagree.
 */
export function allLinks(root = DEFAULT_ROOT) {
  const links = [];
  const unreadable = [];
  for (const blueprint of blueprintPaths(root)) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(root, blueprint, "package.json"), "utf8"));
    } catch (err) {
      unreadable.push({ blueprint, reason: `package.json could not be read: ${err.message}` });
      continue;
    }
    for (const link of linksIn(manifest)) links.push({ ...link, blueprint });
  }
  return { links, unreadable };
}

/**
 * Declared link targets that do not resolve to the package they name.
 *
 * Reports the specifier as written and the path it resolved to, because the
 * two differ by the blueprint's own depth and a reader chasing the failure
 * needs both.
 */
export function findBrokenLinks(root = DEFAULT_ROOT) {
  const { links, unreadable } = allLinks(root);
  const problems = unreadable.map((entry) => ({
    blueprint: entry.blueprint,
    name: null,
    specifier: null,
    reason: entry.reason,
  }));

  for (const link of links) {
    const resolved = join(root, link.blueprint, link.target);
    const shown = relative(root, resolved);
    const problem = (reason) => problems.push({ ...link, reason });

    let stat;
    try {
      stat = statSync(resolved);
    } catch {
      problem(`\`${link.target}\` resolves to \`${shown}\`, which does not exist`);
      continue;
    }
    if (!stat.isDirectory()) {
      problem(`\`${link.target}\` resolves to \`${shown}\`, which is not a directory`);
      continue;
    }

    let targetName;
    try {
      targetName = JSON.parse(readFileSync(join(resolved, "package.json"), "utf8")).name;
    } catch {
      problem(`\`${shown}\` holds no readable package.json, so it is not a package`);
      continue;
    }
    if (targetName !== link.name) {
      problem(
        `\`${shown}\` is \`${String(targetName)}\`, but the blueprint imports it as ` +
          `\`${link.name}\` — point the specifier at the right package, or rename the import`,
      );
    }
  }
  return problems;
}

function main() {
  const root = process.env["POLARIS_BLUEPRINT_ROOT"] ?? DEFAULT_ROOT;
  const problems = findBrokenLinks(root);

  if (problems.length === 0) {
    const { links } = allLinks(root);
    const blueprints = blueprintPaths(root).length;
    console.log(
      `blueprint links: ${String(links.length)} local-path dependency(s) across ` +
        `${String(blueprints)} blueprint(s) resolve to the package they name.`,
    );
    return;
  }

  console.error(
    `blueprint links: ${String(problems.length)} declared link target(s) that do not\n` +
      "resolve. A blueprint depends on Polaris by path rather than by workspace\n" +
      "membership, so a move that renames a directory strands it silently.\n",
  );
  for (const problem of problems) {
    console.error(`  ${problem.blueprint}/`);
    if (problem.name !== null) console.error(`    ${problem.name}: ${problem.specifier}`);
    console.error(`    -> ${problem.reason}\n`);
  }
  console.error(
    "Fix the specifier, then re-run `pnpm install --ignore-workspace` inside the\n" +
      "blueprint so its lockfile and node_modules follow.",
  );
  process.exitCode = 1;
}

if (process.argv[1]?.endsWith("lint-blueprint-links.mjs")) {
  main();
}
