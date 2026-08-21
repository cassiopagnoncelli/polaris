#!/usr/bin/env node
// Polaris blueprint package-manager check.
//
// A blueprint installs with `pnpm install --ignore-workspace`, and
// `--ignore-workspace` is as literal as it sounds: pnpm stops looking upward,
// so the root package.json — and the `packageManager` field that is the one
// place this repository writes its pnpm version — is never read. Whatever
// pnpm is on the operator's PATH is the pnpm the blueprint gets.
//
// ## Why a check and not a careful reading
//
// Because the drift is silent from both ends. `01-storefront` installed under
// pnpm 10.30.0 while the root pinned 11.21.0 and neither side complained:
// pnpm 10 is a working pnpm, the install succeeded, and the lockfile it wrote
// was a lockfile. Nothing goes red until a version-sensitive difference lands,
// and the repository has already paid for one of those in full. `NV933` was a
// `pnpm deploy` that changed its default at v10 and seventeen images that had
// been unbuildable from that day, found three times by cards doing something
// else and never by a build.
//
// ## The rule, and why it is the opposite of the Dockerfiles' rule
//
// `lint-docker-deploy` FORBIDS a `pnpm@x.y.z` in a Dockerfile. This file
// REQUIRES one in a blueprint. Same number, same repository, opposite rules —
// and the thing that differs is whether the file can reach the original:
//
//   - A Dockerfile can. `packageManager` travels in the build context, pnpm
//     reads it and self-manages, so a pin there is a second copy of a fact
//     already in the tree, and a stale copy of this exact number has bitten
//     this repository three times.
//   - A blueprint cannot. `--ignore-workspace` is the property that makes the
//     tier worth having: it proves the SDKs are usable from outside the
//     monorepo, which it could not prove if it resolved anything through
//     workspace membership. The copy is the price of that proof.
//
// So the copy is mandatory here, and a gate holding it equal to the original
// is the only thing that makes a mandatory copy safe.
//
// ## What it checks
//
// For every blueprint the tier holds:
//
//   1. it DECLARES `packageManager`;
//   2. the declaration is character-for-character the root's.
//
// Equality rather than a version comparison, because corepack reads the whole
// string: a `+sha512...` integrity suffix on one side and not the other is two
// different pins however alike the numbers look.
//
// It also fails when the ROOT has no pin, rather than reporting every
// blueprint clean against a source of truth that is not there. A comparison
// with nothing to compare against passes vacuously, which is the shape of
// every decorative check this repository has had to go back and fix.
//
// ## What it deliberately does not check
//
// Which pnpm actually ran. That is a property of a machine at a moment, not
// of the tracked tree, and the blueprint's own `pnpm-lock.yaml` — the one
// artifact that would record it — is gitignored, so a rule over it could
// never fire in CI. The manifest is the tracked surface, so the manifest is
// the gate; the same division `lint-blueprint-links` draws next door.
//
// Run it as:
//
//   node scripts/lint-blueprint-pnpm.mjs
//
// Set POLARIS_BLUEPRINT_PNPM_ROOT to scan a fixture tree (used by the test).

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { blueprintPaths } from "./lint-blueprint-links.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, "..");

/** The manifest field corepack reads, in the root and in every blueprint. */
export const PIN_FIELD = "packageManager";

/**
 * Split a pin into the parts a message has to name separately.
 *
 * `pnpm@11.21.0` and `yarn@11.21.0` differ in a way a reader fixes one way,
 * `pnpm@11.21.0` and `pnpm@10.30.0` in a way they fix another, and "these two
 * strings are not equal" is not enough to tell which.
 */
export function parsePin(pin) {
  if (typeof pin !== "string" || pin.length === 0) return null;
  const at = pin.lastIndexOf("@");
  if (at <= 0) return { manager: pin, version: "" };
  return { manager: pin.slice(0, at), version: pin.slice(at + 1) };
}

/**
 * How a blueprint's pin fails to be the root's, or `null` when it does not.
 *
 * Pure, so the law this gate enforces is testable without a tree on disk.
 */
export function driftReason(declared, expected) {
  if (declared === undefined || declared === null) {
    return (
      `declares no \`${PIN_FIELD}\`, so \`pnpm install --ignore-workspace\` here runs ` +
      `under whatever pnpm is on PATH — add \`"${PIN_FIELD}": "${expected}"\``
    );
  }
  if (typeof declared !== "string") {
    return `declares \`${PIN_FIELD}\` as ${typeof declared}; corepack reads a string — write \`"${expected}"\``;
  }
  if (declared === expected) return null;
  const mine = parsePin(declared);
  const theirs = parsePin(expected);
  if (mine?.manager !== theirs?.manager) {
    return `pins \`${declared}\`, a different package manager from the root's \`${expected}\``;
  }
  return `pins \`${declared}\` while the root pins \`${expected}\``;
}

/** The root's pin, or the reason there is nothing to compare against. */
export function rootPin(root = DEFAULT_ROOT) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch (err) {
    return { pin: null, problem: `the root package.json could not be read: ${err.message}` };
  }
  const pin = manifest[PIN_FIELD];
  if (typeof pin !== "string" || pin.length === 0) {
    return {
      pin: null,
      problem:
        `the root package.json declares no \`${PIN_FIELD}\`, so nothing states the ` +
        `version a blueprint is meant to copy`,
    };
  }
  return { pin, problem: null };
}

/** Every blueprint whose pin is not the root's, and why. */
export function findPinDrift(root = DEFAULT_ROOT) {
  const { pin: expected, problem } = rootPin(root);
  if (expected === null) return [{ where: "package.json", reason: problem }];

  const problems = [];
  for (const blueprint of blueprintPaths(root)) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(root, blueprint, "package.json"), "utf8"));
    } catch (err) {
      problems.push({ where: blueprint, reason: `package.json could not be read: ${err.message}` });
      continue;
    }
    const reason = driftReason(manifest[PIN_FIELD], expected);
    if (reason !== null) problems.push({ where: blueprint, reason });
  }
  return problems;
}

function main() {
  const root = process.env["POLARIS_BLUEPRINT_PNPM_ROOT"] ?? DEFAULT_ROOT;
  const problems = findPinDrift(root);

  if (problems.length === 0) {
    const { pin } = rootPin(root);
    const count = blueprintPaths(root).length;
    console.log(
      `blueprint pnpm: ${String(count)} blueprint(s) pin \`${String(pin)}\`, the same ` +
        `${PIN_FIELD} as the root.`,
    );
    return;
  }

  console.error(
    `blueprint pnpm: ${String(problems.length)} blueprint(s) do not pin the root's pnpm.\n` +
      "A blueprint installs with `--ignore-workspace`, which does not read the root\n" +
      "package.json, so an unpinned tier floats on whatever pnpm the machine has.\n",
  );
  for (const problem of problems) {
    console.error(`  ${problem.where}/`);
    console.error(`    -> ${problem.reason}\n`);
  }
  console.error(
    "Then re-run `pnpm install --ignore-workspace` inside the blueprint so its\n" +
      "lockfile is written by the pnpm the manifest now names.",
  );
  process.exitCode = 1;
}

if (process.argv[1]?.endsWith("lint-blueprint-pnpm.mjs")) {
  main();
}
