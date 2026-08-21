#!/usr/bin/env node
// Polaris injected-copy sync.
//
// Makes a freshly provisioned tree buildable, and says so when it already is.
//
// ## The trap
//
// ADR-0008 turned on `injectWorkspacePackages`, because `pnpm deploy` has to
// put real files in `/deploy` rather than symlinks pointing out of it. Under
// injection pnpm stops symlinking part of the workspace graph to its sources
// and takes a COPY instead — a hard-linked snapshot under
// `node_modules/.pnpm/<name>@file+<path>/` — then points the dependent at the
// snapshot.
//
// The snapshot is taken during `pnpm install`, and it holds what the source
// held at that moment. On a fresh worktree `dist/` does not exist at that
// moment: it is the build's output and the build has not run. So
//
//   1. `pnpm install` snapshots the source WITHOUT `dist/`.
//   2. `pnpm build` builds the SOURCE. Nothing updates the snapshot.
//   3. The snapshot's own package.json still says `"types": "./dist/index.d.ts"`.
//   4. `tsc` follows that to a file which is not there and reports
//      `TS2307: Cannot find module '@polaris/<x>'` — naming a package that is
//      present, declared, and correctly linked, from a package the change
//      being built never touched.
//   5. `pnpm install --force` reports "Already up to date" and changes
//      nothing. It is telling the truth. The lockfile IS current; freshness
//      is not the problem, which is why the obvious remedy lies about having
//      fixed it.
//
// Step 5 is the expensive part. Two workers lost a diagnostic cycle each
// looking for a defect in `libs/delivery/port` and `libs/delivery/host`, and
// a group's `land` failed on a build error in a package none of its four
// cards had touched.
//
// ## The repair, and why it is two steps rather than one
//
// pnpm decides whether the workspace needs re-linking by consulting
// `node_modules/.pnpm-workspace-state-v1.json`. Delete it and the next
// install re-injects. That alone is not enough: re-injecting before the
// sources are built snapshots the same emptiness again. So the order is
//
//   build the sources that get injected  ->  drop the state file  ->  install
//
// and the closure is `pnpm --filter "<pkg>..."`, i.e. each injected package
// AND ITS DEPENDENCIES. The dependents direction (`...<pkg>`) is the wrong
// one and fails: it drags in packages that consume workspace deps which are
// not injected and have not been built yet.
//
// Then it verifies, because a repair that cannot report its own result is
// indistinguishable from the `--force` that says "Already up to date".
//
// ## Three ways an entrypoint can be missing, and why they are told apart
//
// Comparing a copy against its own package.json finds every absent file and
// tells you nothing about which of them matters. The source is the second
// opinion that separates them:
//
//   - STALE — the source has the file, the copy does not. The injection
//     failure above. Re-injection fixes it.
//   - UNBUILT — neither has it, and the source has no such directory at all.
//     The source has not been built. Re-injecting first would snapshot the
//     same emptiness, which is why the repair below builds before it
//     re-injects and why `--check` calls this a failure rather than parity.
//   - NEVER PRODUCED — neither has it, but the source's `dist/` is there. The
//     package declares an `exports` subpath that nothing emits. That is a
//     defect in the package, not in the injection; no amount of re-injecting
//     produces it, so it is reported as a note and does not fail. Failing on
//     one would leave this script unable to report success on a tree it had
//     just correctly repaired.
//
// The repair itself is unconditional. An earlier draft checked first and
// skipped the work when nothing looked stale — on a cold tree, where neither
// side has any `dist/`, that reported "all in sync" and did nothing. A green
// report from a run that did no work is the exact shape of the
// `--force` that says "Already up to date".
//
// ## Usage
//
//   node scripts/sync-injected-workspace-copies.mjs            # repair
//   node scripts/sync-injected-workspace-copies.mjs --check    # report only
//
// Deliberately NOT a pnpm script. `scripts/lint-gate-parity.mjs` holds the
// set of pnpm scripts CI runs equal to the set `pnpm verify` runs; naming
// this one there would invite it into a workflow and then demand it join the
// gate, and it is provisioning rather than a gate. `images.yml` shells out to
// `node scripts/...` for the same reason.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, "..");

/** pnpm's virtual store, relative to the repository root. */
export const VIRTUAL_STORE = join("node_modules", ".pnpm");

/**
 * The file pnpm consults to decide the workspace is unchanged.
 *
 * Removing it is what makes the next install re-inject. Neither
 * `pnpm install` nor `pnpm install --force` does this on its own, which is
 * the whole reason this script exists.
 */
export const WORKSPACE_STATE_FILE = join("node_modules", ".pnpm-workspace-state-v1.json");

/** The marker that separates an injected package's name from its source path. */
const INJECTED_MARKER = "@file+";

/**
 * Decode one virtual-store directory name.
 *
 * `@polaris+delivery-destinations@file+libs+delivery+destinations` is
 * `@polaris/delivery-destinations` injected from `libs/delivery/destinations`
 * — pnpm writes `/` as `+` on both sides of the marker.
 *
 * Returns `null` for every directory that is not an injected workspace
 * package, which is most of them: a registry dependency is `typescript@6.0.3`
 * and has no marker.
 *
 * @param {string} dirName
 * @returns {{name: string, sourcePath: string} | null}
 */
export function parseVirtualStoreDirName(dirName) {
  const marker = dirName.indexOf(INJECTED_MARKER);
  if (marker <= 0) return null;

  const name = dirName.slice(0, marker).replace(/\+/g, "/");
  // A peer-dependency suffix, when there is one, is parenthesised:
  // `@polaris+bus@file+libs+bus(@types+node@22.19.19)`. Cut at the paren and
  // not at `_`, which is a legal character in a directory name.
  const encodedPath = dirName.slice(marker + INJECTED_MARKER.length).split("(")[0];
  if (name.length === 0 || encodedPath === undefined || encodedPath.length === 0) return null;

  return { name, sourcePath: encodedPath.replace(/\+/g, "/") };
}

/** Read and parse a package.json, or `null` when it is absent or unparseable. */
function readManifest(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Every relative path a package.json points a consumer at.
 *
 * `main`, `module`, `types`/`typings`, each `bin` target, and every string
 * leaf of `exports` — the conditions nest, and which one resolves depends on
 * the consumer, so all of them have to be there rather than the ones this
 * repository happens to use today.
 *
 * Bare specifiers are dropped: an `exports` value that does not start with
 * `.` is a package name being re-exported, not a file in this tree.
 *
 * @param {unknown} manifest
 * @returns {string[]} Deduplicated, in first-seen order.
 */
export function declaredEntrypoints(manifest) {
  if (manifest === null || typeof manifest !== "object") return [];
  const found = [];

  const take = (value) => {
    if (typeof value !== "string") return;
    if (!value.startsWith(".")) return;
    if (!found.includes(value)) found.push(value);
  };

  const record = /** @type {Record<string, unknown>} */ (manifest);
  for (const key of ["main", "module", "types", "typings"]) take(record[key]);

  const bin = record["bin"];
  if (typeof bin === "string") take(bin);
  else if (bin !== null && typeof bin === "object") {
    for (const value of Object.values(bin)) take(value);
  }

  const walk = (node) => {
    if (typeof node === "string") {
      take(node);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const value of Object.values(node)) walk(value);
  };
  walk(record["exports"]);

  return found;
}

/**
 * Split a copy's declared entrypoints by where they are actually missing.
 *
 * See the header for what the three buckets mean. The discriminator between
 * the last two is the entrypoint's containing directory: a source with no
 * `dist/` has not been built, and a source with a `dist/` that lacks this one
 * file emits everything except this one file.
 *
 * @param {string} copyDir
 * @param {string} sourceDir
 * @param {unknown} manifest
 * @returns {{stale: string[], unbuilt: string[], neverProduced: string[]}}
 */
export function classifyEntrypoints(copyDir, sourceDir, manifest) {
  const stale = [];
  const unbuilt = [];
  const neverProduced = [];
  for (const entry of declaredEntrypoints(manifest)) {
    if (existsSync(resolve(copyDir, entry))) continue;
    if (existsSync(resolve(sourceDir, entry))) stale.push(entry);
    else if (existsSync(dirname(resolve(sourceDir, entry)))) neverProduced.push(entry);
    else unbuilt.push(entry);
  }
  return { stale, unbuilt, neverProduced };
}

/**
 * Every injected workspace copy in a tree.
 *
 * Each entry carries what the store says (`name`, `sourcePath`) and what the
 * copy itself says (`manifest`), so a caller can compare them rather than
 * trust the directory-name encoding. `sourceName` is `null` when the decoded
 * path holds no package.json — which would mean the encoding above no longer
 * describes what pnpm writes, and is reported rather than skipped.
 *
 * Returns `[]` when there is no virtual store: nothing is installed, or
 * injection is off, and neither is this script's business to complain about.
 *
 * @param {string} root
 */
export function findInjectedCopies(root = DEFAULT_ROOT) {
  let entries;
  try {
    entries = readdirSync(join(root, VIRTUAL_STORE), { withFileTypes: true });
  } catch {
    return [];
  }

  const copies = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const parsed = parseVirtualStoreDirName(entry.name);
    if (parsed === null) continue;

    const segments = parsed.name.split("/");
    const copyDir = join(root, VIRTUAL_STORE, entry.name, "node_modules", ...segments);
    const sourceDir = join(root, parsed.sourcePath);
    const sourceManifest = readManifest(join(sourceDir, "package.json"));
    copies.push({
      name: parsed.name,
      sourcePath: parsed.sourcePath,
      copyDir,
      sourceDir,
      manifest: readManifest(join(copyDir, "package.json")),
      sourceName: typeof sourceManifest?.name === "string" ? sourceManifest.name : null,
    });
  }
  return copies;
}

/**
 * Everything wrong with the injected copies in a tree.
 *
 *   - `unresolved` — the copy has no package.json, or the source path decoded
 *     from the store does not hold the package the copy claims to be. The
 *     encoding this script reads has changed, and every conclusion below it
 *     is worthless. Fatal.
 *   - `stale` — the copy is missing files its source has. This is the TS2307,
 *     and it is what re-injection repairs. Fatal.
 *   - `unbuilt` — the source has not been built, so there is nothing to
 *     inject yet. Fatal: the tree cannot build in this state either.
 *   - `neverProduced` — declared by the package, emitted by nothing.
 *     Reported, not fatal.
 *
 * @param {string} root
 */
export function findProblems(root = DEFAULT_ROOT) {
  const unresolved = [];
  const stale = [];
  const unbuilt = [];
  const neverProduced = [];

  for (const copy of findInjectedCopies(root)) {
    if (copy.manifest === null || copy.sourceName !== copy.name) {
      unresolved.push(copy);
      continue;
    }
    const split = classifyEntrypoints(copy.copyDir, copy.sourceDir, copy.manifest);
    if (split.stale.length > 0) stale.push({ ...copy, missing: split.stale });
    if (split.unbuilt.length > 0) unbuilt.push({ ...copy, missing: split.unbuilt });
    if (split.neverProduced.length > 0) {
      neverProduced.push({ ...copy, missing: split.neverProduced });
    }
  }

  return { unresolved, stale, unbuilt, neverProduced };
}

/** Run a command with its output attached to this process. */
function run(command, args, root) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error !== undefined) return { ok: false, reason: result.error.message };
  if (result.status !== 0) return { ok: false, reason: `exit status ${String(result.status)}` };
  return { ok: true, reason: "" };
}

function reportCopies(copies, write) {
  for (const copy of copies) {
    write(`  ${copy.name} (from ${copy.sourcePath})`);
    for (const entry of copy.missing) write(`    missing ${entry}`);
  }
}

function reportUnresolved(unresolved) {
  console.error(
    "Injected copies this script cannot account for. It reads the source path out of\n" +
      "  the virtual-store directory name, and that encoding no longer holds:",
  );
  for (const copy of unresolved) {
    console.error(
      `  ${copy.name}: store says ${copy.sourcePath}, which holds ` +
        `${copy.sourceName === null ? "no package.json" : copy.sourceName}`,
    );
  }
}

function reportNeverProduced(neverProduced) {
  if (neverProduced.length === 0) return;
  console.log(
    "\nNote — entrypoints a package declares and its build does not emit, so they are\n" +
      "  absent from the source as well as from its copy. Not an injection problem and\n" +
      "  not repairable by one; an importer of these subpaths would fail everywhere:",
  );
  reportCopies(neverProduced, (line) => {
    console.log(line);
  });
}

/** Print the fatal buckets. Returns true when there was something to print. */
function reportFatal({ unresolved, stale, unbuilt }, write) {
  if (unresolved.length > 0) {
    reportUnresolved(unresolved);
    return true;
  }
  if (stale.length > 0) {
    write("Injected workspace copies are missing files their sources have:");
    reportCopies(stale, write);
  }
  if (unbuilt.length > 0) {
    write("Injected workspace copies whose source has not been built:");
    reportCopies(unbuilt, write);
  }
  return stale.length > 0 || unbuilt.length > 0;
}

/**
 * Build every injected package's dependency closure, re-inject, and verify.
 *
 * @param {string} root
 * @returns {number} A process exit code.
 */
export function sync(root = DEFAULT_ROOT) {
  const copies = findInjectedCopies(root);
  if (copies.length === 0) {
    console.log(
      "No injected workspace copies in this tree.\n" +
        `  Nothing to sync. Either ${VIRTUAL_STORE} does not exist yet — run \`pnpm install\`\n` +
        "  first — or `injectWorkspacePackages` is off, which ADR-0008 says it must not be.",
    );
    return 0;
  }

  const before = findProblems(root);
  if (before.unresolved.length > 0) {
    reportUnresolved(before.unresolved);
    return 1;
  }
  console.log(`Re-syncing ${String(copies.length)} injected workspace copies.`);

  // The whole closure, not just the stale members: building one injected
  // package can need another's dist, and the set that is stale now is not the
  // set that will be stale after the first of them is rebuilt.
  const filters = copies.flatMap((copy) => ["--filter", `${copy.name}...`]);
  console.log("\nBuilding the sources that get injected, and their dependencies...");
  const built = run("pnpm", [...filters, "--if-present", "run", "build"], root);
  if (!built.ok) {
    console.error(
      `\nThe build failed (${built.reason}).\n` +
        "  That is a build error rather than an injection problem — this script cannot\n" +
        "  snapshot output that was never produced. Fix the build and run it again.",
    );
    return 1;
  }

  console.log(`\nRe-injecting: removing ${WORKSPACE_STATE_FILE} and installing...`);
  rmSync(join(root, WORKSPACE_STATE_FILE), { force: true });
  // `--frozen-lockfile` because re-linking is the entire job. Removing the
  // state file makes pnpm re-inject either way (`Packages: +11`), and the
  // flag is what keeps a provisioning step from quietly rewriting the
  // lockfile in CI. A tree whose lockfile really is out of date fails here
  // with ERR_PNPM_OUTDATED_LOCKFILE, which is the honest answer: run a real
  // `pnpm install` first.
  const installed = run("pnpm", ["install", "--frozen-lockfile"], root);
  if (!installed.ok) {
    console.error(
      `\n\`pnpm install --frozen-lockfile\` failed (${installed.reason}).\n` +
        "  If it is ERR_PNPM_OUTDATED_LOCKFILE, a dependency changed without the\n" +
        "  lockfile being regenerated. Run `pnpm install`, commit the lockfile, and\n" +
        "  run this again.",
    );
    return 1;
  }

  const after = findProblems(root);
  console.error("");
  if (
    reportFatal(after, (line) => {
      console.error(line);
    })
  ) {
    console.error(
      "\n  The build and the re-injection both ran, and this is what is left. The cause\n" +
        "  is not the one this script knows about. Check that the missing paths are\n" +
        "  covered by the source package's `files` list — injection copies what `files`\n" +
        "  names, so an entrypoint outside it never arrives however often the tree is\n" +
        "  re-injected.",
    );
    return 1;
  }

  console.log(`${String(findInjectedCopies(root).length)} injected workspace copies in sync.`);
  reportNeverProduced(after.neverProduced);
  return 0;
}

function main() {
  const root = process.env["POLARIS_INJECTED_SYNC_ROOT"] ?? DEFAULT_ROOT;

  if (!process.argv.slice(2).includes("--check")) {
    process.exit(sync(root));
  }

  const problems = findProblems(root);
  const fatal = reportFatal(problems, (line) => {
    console.error(line);
  });
  if (fatal || problems.unresolved.length > 0) {
    console.error(
      "\n  A dependent resolving through one of these gets `TS2307: Cannot find module`\n" +
        "  naming a package that is present and correctly linked. Repair it with\n" +
        "    node scripts/sync-injected-workspace-copies.mjs",
    );
    process.exit(1);
  }
  console.log(`${String(findInjectedCopies(root).length)} injected workspace copies in sync.`);
  reportNeverProduced(problems.neverProduced);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
