#!/usr/bin/env node
import { ExitCode } from "../errors.js";
/**
 * `polaris` binary entry point.
 *
 * Kept intentionally tiny so all the meaningful logic stays in plain
 * functions inside `src/` that are easy to test. This file:
 *
 *   1. Forwards `process.argv` (stripped of the node / script entries) to
 *      `run`, which builds and parses the commander program.
 *   2. Awaits the resolved exit code and hands it to `process.exit`.
 *
 * `run` never throws — it converts any uncaught error into an exit code and
 * a stderr message. We also install a top-level safety net for the rare case
 * where something inside an async handler fires after `run` has already
 * resolved, so the process still terminates cleanly.
 */
import { run } from "../program.js";

// Pino flush helper: gives the logger a chance to drain to stderr before the
// process exits. Pino is synchronous by default, so this is effectively a
// no-op today, but it keeps the door open for an async destination later
// (e.g. shipping logs to a tail file) without changing the CLI contract.
function flushAndExit(code: number): void {
  // `process.exitCode` rather than `process.exit` lets pending writes flush.
  process.exitCode = code;
}

process.on("uncaughtException", (error) => {
  process.stderr.write(`polaris: uncaught exception: ${error?.message ?? String(error)}\n`);
  if (process.env["POLARIS_DEBUG"] === "1" && error?.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  flushAndExit(ExitCode.GenericFailure);
});

process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`polaris: unhandled rejection: ${message}\n`);
  flushAndExit(ExitCode.GenericFailure);
});

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const code = await run({ argv });
  flushAndExit(code);
}

void main();
