#!/usr/bin/env node
// Polaris gate-parity check.
//
// The gate a group runs before it lands and the gate CI runs after it landed
// have to be the same set of commands. This file is where that is written
// down, and `pnpm verify` is the set.
//
// ## Why this exists
//
// Because the two drifted, and the drift was invisible from both sides. The
// T0 group's verify command was `pnpm build && pnpm typecheck && pnpm lint &&
// pnpm test`; `ci.yml` ran those four AND `pnpm format:check`. Nothing
// compared them. So `IJ4NN` renamed packages to longer names, thirty-four
// files' imports went past biome's print width, the group gate stayed green
// through every card, the group landed, and `main` went red on a push.
//
// The twenty-odd reformatted files were the symptom. The defect was that the
// group gate was a SUBSET of CI's and no artifact anywhere said it must not
// be. A subset gate does not report that it is a subset — it reports success,
// which is the same shape as the pnpm version that broke this repository's CI
// for seven days and the three checks that passed on the bugs they were
// written for.
//
// ## What it checks
//
// One rule, both directions: the pnpm scripts `pnpm verify` runs and the pnpm
// scripts CI runs on a bare checkout are the same set.
//
//   - A gate in CI but not in `verify` is the failure above: the group gate
//     cannot see something that will fail after it lands.
//   - A gate in `verify` but not in CI is the mirror: work is being gated on
//     something `main` does not enforce, so it holds only as long as everyone
//     keeps running it by hand.
//
// ## What "on a bare checkout" excludes, and what that costs
//
// A group's verify runs in a git worktree with a node_modules and nothing
// else. Gates that need more than that cannot be in `pnpm verify`, so they
// are not compared:
//
//   - Jobs declaring `services:` — `ci.yml`'s `migrations` job needs a live
//     PostgreSQL for `pnpm db:migrate`. Read off the workflow, not listed
//     here, so a new service-backed job is excluded the moment it declares
//     one.
//   - The workflows in NEEDS_MORE_THAN_A_CHECKOUT below, each with the
//     reason. That list is the part a reader should distrust: it is the same
//     kind of artifact as the missing `format:check`, and it goes stale the
//     same way. It is two entries and every entry names what it needs.
//
// The remaining hole, stated rather than left to be discovered: a gate that
// runs on a bare checkout from a workflow this file excludes is invisible to
// it. Neither excluded workflow has one today — `images.yml` shells out to
// `node scripts/...` and needs a daemon, `integration.yml` needs a compose
// stack — and adding one is a reason to come back here.
//
// Run it as:
//
//   node scripts/lint-gate-parity.mjs
//
// Set POLARIS_GATE_PARITY_ROOT to scan a fixture tree (used by the test).

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, "..");

/** Where the workflows live, relative to the repository root. */
export const WORKFLOWS_DIR = ".github/workflows";

/** The root script that IS the group gate. */
export const VERIFY_SCRIPT = "verify";

/**
 * Workflows whose jobs need something a group worktree does not have.
 *
 * Keyed by file name, valued by what it needs — the reason is the point.
 * `format:check` went unenforced for a group because the difference between
 * the two gate sets was written down nowhere; an exclusion with no stated
 * reason is that same silence with a comment character in front of it.
 */
export const NEEDS_MORE_THAN_A_CHECKOUT = {
  "images.yml": "a Docker daemon, to build production images",
  "integration.yml": "a compose stack: PostgreSQL, Redis, RabbitMQ, ClickHouse",
};

/**
 * The pnpm scripts a shell command runs, in order.
 *
 * Split on the separators a gate chain uses (`&&`, `;`, newlines) and read
 * the head of each piece. Only names the root package.json actually defines
 * are returned, which is what keeps `pnpm install --frozen-lockfile` out:
 * `install` is pnpm's own verb, not a script, and installing is setup rather
 * than a gate.
 *
 * @param {string} command
 * @param {Set<string>} scriptNames Keys of the root package.json `scripts`.
 * @returns {string[]}
 */
export function parseGateChain(command, scriptNames) {
  const found = [];
  for (const piece of String(command).split(/&&|\|\||;|\n/)) {
    const tokens = piece.trim().split(/\s+/).filter(Boolean);
    if (tokens.shift() !== "pnpm") continue;

    // Drop options. `--filter` takes a value, and dropping the flag without
    // it would read the package name as the script.
    while (tokens.length > 0 && tokens[0].startsWith("-")) {
      const flag = tokens.shift();
      if ((flag === "--filter" || flag === "-F") && tokens.length > 0) tokens.shift();
    }
    if (tokens[0] === "run") tokens.shift();

    const name = tokens[0];
    if (name !== undefined && scriptNames.has(name)) found.push(name);
  }
  return found;
}

/**
 * Whether a parsed workflow runs on a pull request or a push.
 *
 * A workflow that runs only on a schedule or a manual dispatch is not a gate
 * on anybody's change, so it is not part of the set a group has to match.
 */
export function isPullRequestGate(workflow) {
  // `on` is YAML 1.1's boolean true. The `yaml` package parses these files as
  // YAML 1.2 -- where it is the string "on" -- but a parser that did not
  // would leave the key under `true`, and the check would silently compare
  // against nothing at all.
  const triggers = workflow?.on ?? workflow?.[true];
  if (triggers === null || typeof triggers !== "object") return false;
  return Object.hasOwn(triggers, "pull_request") || Object.hasOwn(triggers, "push");
}

/**
 * Every pnpm gate a workflow runs on a bare checkout.
 *
 * @returns {Map<string, string[]>} Script name -> the jobs that run it.
 */
export function readWorkflowGates(source, scriptNames) {
  const gates = new Map();
  let workflow;
  try {
    workflow = parseYaml(source);
  } catch {
    return gates;
  }
  if (workflow === null || typeof workflow !== "object") return gates;
  if (!isPullRequestGate(workflow)) return gates;

  const jobs = workflow.jobs;
  if (jobs === null || typeof jobs !== "object") return gates;

  for (const [jobName, job] of Object.entries(jobs)) {
    if (job === null || typeof job !== "object") continue;
    // Needs a live service, so a group worktree cannot run it.
    if (Object.hasOwn(job, "services")) continue;
    const steps = Array.isArray(job.steps) ? job.steps : [];
    for (const step of steps) {
      if (step === null || typeof step !== "object") continue;
      if (typeof step.run !== "string") continue;
      for (const name of parseGateChain(step.run, scriptNames)) {
        const seen = gates.get(name) ?? [];
        if (!seen.includes(jobName)) seen.push(jobName);
        gates.set(name, seen);
      }
    }
  }
  return gates;
}

/** Workflow file names, sorted, or an empty list when there is no directory. */
export function findWorkflows(root = DEFAULT_ROOT) {
  try {
    return readdirSync(join(root, WORKFLOWS_DIR))
      .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Everything the two gate sets disagree about.
 *
 * @returns {string[]} One paragraph per problem, empty when they agree.
 */
export function findProblems(root = DEFAULT_ROOT) {
  const problems = [];

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return ["package.json is missing or unparseable, so there is no gate set to compare."];
  }
  const scripts =
    manifest.scripts !== null && typeof manifest.scripts === "object" ? manifest.scripts : {};
  const scriptNames = new Set(Object.keys(scripts));

  const verify = scripts[VERIFY_SCRIPT];
  if (typeof verify !== "string" || verify.trim().length === 0) {
    problems.push(
      `The root package.json has no \`${VERIFY_SCRIPT}\` script.\n` +
        "    It is the command a group runs before it lands, and the one place this\n" +
        "    repository writes down what the gate is. Without it the group gate and CI\n" +
        "    have nothing to be compared against each other.",
    );
    return problems;
  }

  const declared = parseGateChain(verify, scriptNames);
  if (declared.includes(VERIFY_SCRIPT)) {
    problems.push(
      `The \`${VERIFY_SCRIPT}\` script runs \`pnpm ${VERIFY_SCRIPT}\`, which never terminates.`,
    );
    return problems;
  }
  const declaredSet = new Set(declared);

  /** @type {Map<string, string[]>} script -> "workflow (job)" */
  const inCi = new Map();
  for (const file of findWorkflows(root)) {
    if (Object.hasOwn(NEEDS_MORE_THAN_A_CHECKOUT, file)) continue;
    let source;
    try {
      source = readFileSync(join(root, WORKFLOWS_DIR, file), "utf8");
    } catch {
      continue;
    }
    for (const [name, jobs] of readWorkflowGates(source, scriptNames)) {
      const where = inCi.get(name) ?? [];
      for (const job of jobs) where.push(`${file} (${job})`);
      inCi.set(name, where);
    }
  }

  if (inCi.size === 0) {
    problems.push(
      "No workflow runs any pnpm gate on a bare checkout, so this check is comparing\n" +
        `    \`pnpm ${VERIFY_SCRIPT}\` against nothing. Either the workflows moved, or every\n` +
        `    push-triggered workflow is now listed in NEEDS_MORE_THAN_A_CHECKOUT.`,
    );
    return problems;
  }

  for (const [name, where] of [...inCi].sort()) {
    if (declaredSet.has(name)) continue;
    problems.push(
      `CI runs \`pnpm ${name}\` and \`pnpm ${VERIFY_SCRIPT}\` does not.\n` +
        `    Run by: ${where.join(", ")}.\n` +
        "    A group gate that is a subset of CI's reports success and then breaks\n" +
        `    \`main\` on the push that lands it. Add \`pnpm ${name}\` to the \`${VERIFY_SCRIPT}\`\n` +
        "    script, or remove the step from the workflow.",
    );
  }

  for (const name of declared) {
    if (inCi.has(name)) continue;
    problems.push(
      `\`pnpm ${VERIFY_SCRIPT}\` runs \`pnpm ${name}\` and no workflow does.\n` +
        "    Nothing enforces it once the change is on `main`, so it holds exactly as\n" +
        "    long as everyone keeps running it by hand. Add a step to\n" +
        `    ${WORKFLOWS_DIR}/ci.yml, or drop it from the \`${VERIFY_SCRIPT}\` script.`,
    );
  }

  return problems;
}

function main() {
  const root = process.env["POLARIS_GATE_PARITY_ROOT"] ?? DEFAULT_ROOT;
  const problems = findProblems(root);

  if (problems.length === 0) {
    let count = 0;
    try {
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      count = parseGateChain(
        manifest.scripts[VERIFY_SCRIPT],
        new Set(Object.keys(manifest.scripts)),
      ).length;
    } catch {
      count = 0;
    }
    console.log(
      `gate-parity check: \`pnpm ${VERIFY_SCRIPT}\` runs the same ${String(count)} gate(s) CI ` +
        "runs on a bare checkout.",
    );
    return;
  }

  console.error(
    `gate-parity check: ${String(problems.length)} difference(s) between the gate a group\n` +
      "runs before it lands and the gate CI runs after it lands.\n",
  );
  for (const problem of problems) console.error(`  ${problem}\n`);
  process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main();
}
