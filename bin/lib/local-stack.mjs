// Shared machinery for the two local entry points, `bin/dev` and `bin/setup`.
//
// Both need the same two things before they touch anything: the repo-root
// `.env.local` loaded into the environment, and any dev stack still running
// from this checkout stopped. They were `bin/dev`'s private helpers until
// `bin/setup` grew a destroy phase and needed both for reasons of its own —
// it resolves which databases to drop from the environment, and it cannot
// drop a database a running service still holds a connection to.
//
// Nothing here is Polaris-specific beyond the pgrep patterns; it is process
// and environment plumbing, kept in one place so the two scripts cannot
// disagree about what "the local stack" means.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, resolved from this file's location (`bin/lib/`). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** How long a previously running stack gets to die before SIGKILL. */
const SWEEP_GRACE_MS = 5_000;

/** How long SIGKILL gets to take effect before anything left is reported. */
const KILL_SETTLE_MS = 2_000;

/** Poll interval while waiting for either grace period above. */
const POLL_MS = 250;

/**
 * How a still-running Polaris service is recognised, as `pgrep -f` patterns.
 *
 * Both are anchored on this checkout's `node_modules`, so a second clone (or
 * a git worktree) running its own stack is left alone. Two patterns because a
 * service is two processes: the `tsx watch` supervisor, and the node process
 * it supervises. The supervisor's group covers both in the normal case — but
 * a supervisor that was SIGKILLed leaves its child orphaned and still holding
 * the port, and that orphan is the one that makes the next start fail with
 * `EADDRINUSE`. Matching it directly is how a stale stack gets cleared
 * instead of diagnosed.
 *
 * Deliberately narrower than "anything running tsx": both patterns require a
 * service entry point (`src/main.ts` / `src/server.ts`), so an unrelated
 * `tsx some-script.ts` in this repo survives `make dev`.
 */
const RUNNING_SERVICE_PATTERNS = [
  `${escapeForPgrep(REPO_ROOT)}/node_modules/.*tsx/dist/cli\\.mjs watch src/(main|server)\\.ts`,
  `${escapeForPgrep(REPO_ROOT)}/node_modules/.*tsx/dist/loader\\.mjs src/(main|server)\\.ts`,
];

/**
 * Put the repo-root `.env.local` into the environment.
 *
 * Services cannot read it themselves: `libs/runtime/config` resolves
 * `.env` files against `process.cwd()`, and a service started by pnpm runs
 * from its own package directory. The Makefile solves this for its targets
 * with `include .env.local`; this is the same trick for the two entry points
 * that no longer go through Make for anything else.
 *
 * Both of them must do this, and for `bin/setup` it is load-bearing rather
 * than convenient: it resolves the endpoints it is about to destroy from the
 * environment, so a `./bin/setup` that skipped this file would target
 * different databases than the `make setup` that includes it.
 *
 * `process.loadEnvFile` leaves variables that are already exported alone,
 * which matches how `shared-config` merges the same file — real environment
 * wins, the file fills the gaps.
 *
 * @throws {Error} if the file exists but cannot be parsed.
 */
export function loadEnvLocal() {
  const envFile = resolve(REPO_ROOT, ".env.local");
  if (!existsSync(envFile)) return;
  try {
    process.loadEnvFile(envFile);
  } catch (err) {
    throw new Error(`could not read .env.local: ${err.message}\n  Expected plain KEY=VALUE lines.`);
  }
}

/**
 * Stop every Polaris service already running from this checkout.
 *
 * Signals process *groups*, not processes: `pnpm`, the `tsx watch`
 * supervisors, and the node processes they supervise all share one group, so
 * one signal per group takes down the whole tree — including the `make` that
 * started it, which is what makes a stack in another terminal go away too.
 *
 * Returns the number of processes that were found running.
 */
export function stopRunningStack() {
  const pids = findRunningServicePids();
  if (pids.length === 0) return 0;

  signalGroups(processGroupsOf(pids), "SIGTERM");
  waitForExitSync(SWEEP_GRACE_MS);

  const stubborn = findRunningServicePids();
  if (stubborn.length > 0) {
    signalGroups(processGroupsOf(stubborn), "SIGKILL");
    waitForExitSync(KILL_SETTLE_MS);
  }

  const survivors = findRunningServicePids();
  if (survivors.length > 0) {
    console.warn(
      `Warning: ${survivors.length} process(es) from a previous stack would not die ` +
        `(${survivors.join(", ")}).\n` +
        "  Something else owns them — `ps -p <pid>` to see what.\n",
    );
  }
  return pids.length;
}

/** Block until no service process is left, or `timeoutMs` passes. */
function waitForExitSync(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && findRunningServicePids().length > 0) {
    sleepSync(POLL_MS);
  }
}

/** PIDs of anything matching `RUNNING_SERVICE_PATTERNS`, deduplicated. */
export function findRunningServicePids() {
  const pids = new Set();
  for (const pattern of RUNNING_SERVICE_PATTERNS) {
    // pgrep exits 1 with no output when nothing matches; that is not an error.
    const result = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
    for (const line of (result.stdout ?? "").split("\n")) {
      const pid = Number.parseInt(line.trim(), 10);
      if (Number.isInteger(pid) && pid > 1) pids.add(pid);
    }
  }
  return [...pids];
}

/**
 * Process-group IDs for the given PIDs, minus this process's own group.
 *
 * The exclusion is not theoretical: `make dev` runs in the same group as the
 * `make` that invoked it and as the caller's shell job, so a pattern that
 * ever matched a sibling of this script would otherwise have it kill its own
 * terminal job on startup.
 */
function processGroupsOf(pids) {
  const own = readProcessGroup(process.pid);
  const groups = new Set();
  for (const pid of pids) {
    const pgid = readProcessGroup(pid);
    if (pgid !== undefined && pgid !== own) groups.add(pgid);
  }
  return [...groups];
}

function readProcessGroup(pid) {
  const result = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" });
  const pgid = Number.parseInt((result.stdout ?? "").trim(), 10);
  return Number.isInteger(pgid) && pgid > 1 ? pgid : undefined;
}

/** Signal whole process groups, ignoring the ones that died in between. */
function signalGroups(groups, signal) {
  for (const pgid of groups) {
    try {
      process.kill(-pgid, signal);
    } catch {
      // ESRCH: the group is already gone, which is the outcome we wanted.
    }
  }
}

/**
 * Block the thread for `ms`.
 *
 * The sweep runs before anything is started and has nothing to interleave
 * with, so it stays synchronous — `Atomics.wait` is the sleep that does not
 * need an event loop turn.
 */
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Escape a literal path for use inside a `pgrep -f` extended regular
 * expression. Repo paths rarely contain metacharacters; a checkout under a
 * directory with a `+` or `(` in its name would silently stop matching.
 */
function escapeForPgrep(literal) {
  return literal.replace(/[.[\]{}()*+?^$|\\]/g, "\\$&");
}
