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

/**
 * `polaris ... | head` closes the pipe as soon as it has its lines. Every
 * later write then fails with EPIPE — including the diagnostic write inside
 * the `uncaughtException` handler below, which re-enters the same handler and
 * spins the process at 100% CPU until it is killed.
 *
 * Node reports the broken pipe as a stream error rather than delivering
 * SIGPIPE, so a truncating reader is a normal, successful end to the run:
 * exit 0 immediately, without touching the streams again.
 */
function isBrokenPipe(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EPIPE";
}

for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: unknown) => {
    if (isBrokenPipe(error)) process.exit(0);
  });
}

/** Never re-throws — a failed diagnostic must not become the next exception. */
function writeDiagnostic(text: string): void {
  try {
    process.stderr.write(text);
  } catch {
    // stderr is gone (closed pipe, full disk). Nothing left to report with.
  }
}

process.on("uncaughtException", (error) => {
  if (isBrokenPipe(error)) process.exit(0);
  writeDiagnostic(`polaris: uncaught exception: ${error?.message ?? String(error)}\n`);
  if (process.env["POLARIS_DEBUG"] === "1" && error?.stack) {
    writeDiagnostic(`${error.stack}\n`);
  }
  flushAndExit(ExitCode.GenericFailure);
});

process.on("unhandledRejection", (reason) => {
  if (isBrokenPipe(reason)) process.exit(0);
  const message = reason instanceof Error ? reason.message : String(reason);
  writeDiagnostic(`polaris: unhandled rejection: ${message}\n`);
  flushAndExit(ExitCode.GenericFailure);
});

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const code = await run({ argv });
  flushAndExit(code);
}

void main();
