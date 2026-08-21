#!/usr/bin/env node
// Polaris deploy-mode check.
//
// Every one of the eighteen Dockerfiles in this repository ends its builder
// stage with the same instruction:
//
//   RUN pnpm --filter "<pkg>" deploy --prod /deploy
//
// and the runtime stage then does `COPY --from=builder /deploy /app`. Two
// repository-level facts have to hold for that pair to work, neither of them
// visible in the Dockerfile that depends on them, and neither of them checked
// by anything else in the gate. This file checks them.
//
// ## Why a check and not a careful reading
//
// Because for most of this repository's life nothing in CI built an image, so
// the feedback for getting either fact wrong was not a red build — it was a
// green one, and a discovery weeks later by whoever first ran
// `pnpm docker:build`.
//
// `images.yml` closed that gap on card `5OV81`, and this check still earns its
// place: it runs in `pnpm lint`, in seconds, against all eighteen Dockerfiles,
// where the per-push build reaches three of them in minutes. It is the cheap
// half of the answer, and the fifteen images the per-push set does not build
// are covered by nothing else until the nightly run.
//
// That is the literal history. `9a5da8d` pinned `pnpm@10.30.0` in every
// Dockerfile while `packageManager` said 11.21.0. `719a9d2` removed the pin
// from seventeen of them and missed `infra/docker/base.Dockerfile`, so the
// canonical template — the file the README designates as the thing every
// other Dockerfile is copied from — sat a major version behind the files it
// governs. Meanwhile pnpm v10 had made non-injected `pnpm deploy` an error,
// which meant all seventeen images had been unbuildable since the day the
// runtime moved to v10, and the three cards that hit it each hit it while
// doing something else.
//
// ## What it looks for
//
//   1. INJECTION IS ON. `pnpm deploy` refuses to run from a workspace without
//      `injectWorkspacePackages`, and injection is the mode these images
//      need rather than a box to tick: it is what makes /deploy's workspace
//      deps real files inside /deploy instead of symlinks pointing out into
//      /workspace, and a symlink pointing out of the tree does not survive
//      `COPY --from=builder /deploy /app`. See
//      docs/adr/0008-inject-workspace-packages-on-deploy.md.
//
//      Checked twice, because each half has a hole the other closes:
//
//      - THE DECLARATION, in pnpm-workspace.yaml. The key is camelCase in
//        this file and kebab-case in `.npmrc`, and pnpm's own error message
//        quotes the `.npmrc` spelling. Writing `inject-workspace-packages`
//        into the YAML is well-formed YAML that pnpm reads as an unknown key
//        and discards in silence: install succeeds, the lockfile records
//        nothing, and deploy fails with the very message that suggested the
//        spelling. This check names that case specifically, because a reader
//        who has just been handed that spelling by the tool will try it.
//      - THE EFFECTIVE VALUE, via `pnpm config get`. A misspelling cannot
//        pass it. Neither can a future rename of the key, which the
//        declaration check alone would keep asserting happily.
//
//      A user-level `~/.npmrc` setting it true would satisfy the effective
//      check on one machine and no other, which is exactly why the
//      declaration is checked too, and in the repository's own file.
//
//   2. EVERY DEPLOY FILTER NAMES THE PACKAGE BESIDE IT. A unit's Dockerfile
//      sits in the same directory as the package.json it builds, so the name
//      in `pnpm --filter "<pkg>" deploy` is checkable against the name in that
//      file. `async/computation/attribution-engine/v3/Dockerfile` filtered for
//      `@polaris/processor-attribution-engine-v1` — a package that exists
//      nowhere in the tree — because v3's Dockerfile was copied from v1's and
//      the name was never changed, along with the OCI labels that went on to
//      describe the wrong version. `pnpm deploy` fails outright on a filter
//      that matches nothing, so this is the second independent reason that
//      image could not be built.
//
//      `base.Dockerfile` filters on `${SERVICE_FILTER}`, a build arg, and has
//      no package beside it; a parameterised filter is skipped rather than
//      guessed at.
//
//   3. NO DOCKERFILE PINS A PNPM VERSION. `packageManager` in the root
//      package.json is the one place the version is written; pnpm reads it
//      and self-manages. A `pnpm@x.y.z` in a Dockerfile is a second copy of
//      that fact which nothing updates when the first one moves, and the
//      repository has now been bitten by a stale copy of this exact number
//      three times — in the CI workflow, in seventeen Dockerfiles, and in
//      the template that outlived their fix.
//
// Run it as:
//
//   node scripts/lint-docker-deploy.mjs
//
// Set POLARIS_DOCKER_DEPLOY_ROOT to scan a fixture tree (used by the test).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import { findDockerfiles } from "./lint-docker-context.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, "..");

/** The key as pnpm-workspace.yaml spells it. */
export const SETTING_CAMEL = "injectWorkspacePackages";
/** The key as `.npmrc` and pnpm's error message spell it. */
export const SETTING_KEBAB = "inject-workspace-packages";

// -----------------------------------------------------------------------------
// 1. Injection is on
// -----------------------------------------------------------------------------

/**
 * Read what pnpm-workspace.yaml DECLARES about injection.
 *
 * @returns {{
 *   declared: boolean,
 *   value: unknown,
 *   misspelled: boolean,
 * }} `misspelled` is the kebab-case key present at the top level — the
 *    silent-no-op case, reported separately because its fix is a rename
 *    rather than an addition.
 */
export function readDeclaration(source) {
  let document;
  try {
    document = parseYaml(source);
  } catch {
    document = null;
  }
  const root = document !== null && typeof document === "object" ? document : {};
  return {
    declared: Object.hasOwn(root, SETTING_CAMEL),
    value: root[SETTING_CAMEL],
    misspelled: Object.hasOwn(root, SETTING_KEBAB),
  };
}

/**
 * Ask pnpm what the setting RESOLVES to, merging every source it consults.
 *
 * Returns null when pnpm cannot be run at all, which is not a failure: the
 * declaration check still applies, and a check that demanded a working pnpm
 * on PATH would fail in environments that have no business running it.
 */
export function readEffective(root = DEFAULT_ROOT) {
  const result = spawnSync("pnpm", ["config", "get", SETTING_KEBAB], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  return result.stdout.trim();
}

// -----------------------------------------------------------------------------
// 2. Every deploy filter names the package beside it
// -----------------------------------------------------------------------------

/**
 * Every `pnpm --filter "<pkg>" deploy` whose package is not the one whose
 * package.json sits in the same directory as the Dockerfile.
 *
 * @returns {Array<{file: string, line: number, filter: string, actual: string}>}
 */
export function findFilterMismatches(root = DEFAULT_ROOT) {
  const problems = [];
  for (const file of findDockerfiles(root)) {
    let source;
    try {
      source = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }

    // The package a unit's Dockerfile is FOR is the one it sits beside.
    // `infra/docker/base.Dockerfile` sits beside none, which is what makes it
    // a template rather than a unit.
    let actual;
    try {
      const manifest = readFileSync(join(root, dirname(file), "package.json"), "utf8");
      actual = JSON.parse(manifest).name;
    } catch {
      continue;
    }
    if (typeof actual !== "string") continue;

    const lines = blankComments(source);
    for (let i = 0; i < lines.length; i++) {
      const match = /pnpm\s+--filter\s+"([^"]+)"\s+deploy/.exec(lines[i] ?? "");
      if (match === null) continue;
      const filter = match[1] ?? "";
      if (filter.includes("${")) continue; // parameterised: the template's shape
      if (filter === actual) continue;
      problems.push({ file, line: i + 1, filter, actual });
    }
  }
  return problems;
}

// -----------------------------------------------------------------------------
// 3. No Dockerfile pins a pnpm version
// -----------------------------------------------------------------------------

/**
 * Blank out Dockerfile comments, keeping one line per line.
 *
 * `#` opens a comment only at the start of a line — inside a line it is an
 * ordinary character — so this is the whole rule. It matters because the
 * comment explaining why the pin is gone would otherwise read as a pin.
 *
 * Blanked rather than dropped so the array index stays the file's line
 * number. Dropping them reported the first fault-injected pin, correctly, at
 * a line fifty-seven rows above the one it was on.
 */
export function blankComments(source) {
  return source.split("\n").map((line) => (line.trim().startsWith("#") ? "" : line));
}

/**
 * Every `pnpm@<version>` written into a Dockerfile.
 *
 * @returns {Array<{file: string, line: number, spec: string}>}
 */
export function findPinnedPnpm(root = DEFAULT_ROOT) {
  const problems = [];
  for (const file of findDockerfiles(root)) {
    let source;
    try {
      source = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    const lines = blankComments(source);
    for (let i = 0; i < lines.length; i++) {
      // `pnpm@` followed by anything version-shaped. Deliberately not
      // limited to `npm install --global`: corepack, volta and a bare
      // `npx pnpm@10` are the same second copy of the same number.
      const match = /\bpnpm@([0-9][^\s"'\\]*)/.exec(lines[i] ?? "");
      if (match === null) continue;
      problems.push({ file, line: i + 1, spec: match[0] });
    }
  }
  return problems;
}

// -----------------------------------------------------------------------------
// Report
// -----------------------------------------------------------------------------

/**
 * Everything wrong with the repository's deploy mode.
 *
 * @returns {string[]} One paragraph per problem, empty when clean.
 */
export function findProblems(root = DEFAULT_ROOT) {
  const problems = [];

  let workspaceSource = "";
  try {
    workspaceSource = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  } catch {
    problems.push("pnpm-workspace.yaml is missing or unreadable.");
  }

  const declaration = readDeclaration(workspaceSource);
  if (declaration.misspelled) {
    problems.push(
      `pnpm-workspace.yaml sets \`${SETTING_KEBAB}\`, which pnpm ignores here.\n` +
        `    That is the \`.npmrc\` spelling, and it is the one pnpm's own error message\n` +
        "    quotes. In this file the key is camelCase, and an unknown key is discarded\n" +
        `    without a warning. Rename it to \`${SETTING_CAMEL}\`.`,
    );
  } else if (!declaration.declared) {
    problems.push(
      `pnpm-workspace.yaml does not set \`${SETTING_CAMEL}\`.\n` +
        "    Without it `pnpm deploy` refuses to run, and every Dockerfile's builder\n" +
        "    stage ends in `pnpm deploy --prod /deploy`, so all seventeen images fail to\n" +
        "    build. Add `" +
        SETTING_CAMEL +
        ": true`.",
    );
  } else if (declaration.value !== true) {
    problems.push(
      `pnpm-workspace.yaml sets \`${SETTING_CAMEL}: ${JSON.stringify(declaration.value)}\`.\n` +
        "    It must be `true`; `pnpm deploy` refuses to run otherwise and the images\n" +
        "    that copy /deploy need injected deps rather than symlinks. See\n" +
        "    docs/adr/0008-inject-workspace-packages-on-deploy.md.",
    );
  }

  const effective = readEffective(root);
  if (effective !== null && effective !== "true") {
    problems.push(
      `\`pnpm config get ${SETTING_KEBAB}\` resolves to \`${effective}\`, not \`true\`.\n` +
        "    Whatever pnpm-workspace.yaml appears to say, this is the value pnpm will\n" +
        "    act on, and `pnpm deploy` will refuse to run.",
    );
  }

  for (const bad of findFilterMismatches(root)) {
    problems.push(
      `${bad.file}:${String(bad.line)} deploys \`${bad.filter}\`,\n` +
        `    but the package beside it is \`${bad.actual}\`. \`pnpm deploy\` fails on a\n` +
        "    filter that matches nothing, so this image cannot build. Usually a\n" +
        "    Dockerfile copied from another version and renamed everywhere except here.",
    );
  }

  for (const pin of findPinnedPnpm(root)) {
    problems.push(
      `${pin.file}:${String(pin.line)} pins \`${pin.spec}\`.\n` +
        "    `packageManager` in the root package.json is where the pnpm version is\n" +
        "    written, and pnpm self-manages to it; a copy here is a second place to\n" +
        "    update and the one nobody remembers. Drop the version:\n" +
        "    `npm install --global pnpm`.",
    );
  }

  return problems;
}

function main() {
  const root = process.env["POLARIS_DOCKER_DEPLOY_ROOT"] ?? DEFAULT_ROOT;
  const problems = findProblems(root);
  const count = findDockerfiles(root).length;

  if (problems.length === 0) {
    console.log(
      `docker-deploy check: injection is on, and all ${String(count)} Dockerfile(s) deploy ` +
        "the package beside them without pinning a pnpm version.",
    );
    return;
  }

  console.error(
    `docker-deploy check: ${String(problems.length)} problem(s) that stop \`pnpm deploy\`\n` +
      "from producing an image, and that no other check in the gate would report.\n",
  );
  for (const problem of problems) console.error(`  ${problem}\n`);
  process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main();
}
