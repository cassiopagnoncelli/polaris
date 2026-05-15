#!/usr/bin/env node

// Polaris product-acceptance runner — P12-003.
//
// Operator entry point invoked as `pnpm test:acceptance`. Wraps the
// Vitest acceptance scenario so the on-call engineer running the
// release gate does not have to remember:
//
//   - which env vars to flip on,
//   - which Vitest invocation pattern matches the gated test file,
//   - what a "pass" looks like.
//
// The script:
//
//   1. Prints a banner declaring this is a real-services run.
//   2. Performs a fast pre-flight: workspace built, env vars set,
//      Postgres reachable. Hard-fails before spawning Vitest.
//   3. Sets `POLARIS_ACCEPTANCE_TEST=1` and execs Vitest scoped to
//      the acceptance scenario file.
//   4. Surfaces the per-step pass/fail table the scenario emits.
//   5. Returns non-zero on any failure.
//
// The script intentionally does NOT call `runAcceptanceScenario`
// directly. Spawning Vitest gives operators the same reporter
// surface as our other test gates (test names, failure traces,
// timeouts, retries) and lets the same harness be invoked from CI
// without a custom wrapper.
//
// @see tests/acceptance/scenarios/full-pipeline.test.ts
// @see docs/release/acceptance-test-runbook.md

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readRepoVersion, resolveRepoArtifacts } from "../tests/acceptance/lib/scenario.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

const BANNER_WIDTH = 78;

function bar(char = "=") {
  return char.repeat(BANNER_WIDTH);
}

function center(text) {
  const padding = Math.max(0, Math.floor((BANNER_WIDTH - text.length) / 2));
  return " ".repeat(padding) + text;
}

function printBanner({ version, scenarioPath, ingesterUrl, projectId, environment }) {
  const lines = [
    bar(),
    center("Polaris Product Acceptance Test"),
    center(`v${version} -- release-gate run`),
    bar(),
    "",
    "  This run drives the canonical happy path end-to-end through real",
    "  services. It is not a unit test — it asserts that one internal",
    "  project can register, send events, persist them, deliver them,",
    "  and replay them on the running platform.",
    "",
    `  Scenario      : ${scenarioPath}`,
    `  Ingester      : ${ingesterUrl}`,
    `  Project / env : ${projectId} / ${environment}`,
    "",
    "  See docs/release/acceptance-test-runbook.md for the full operator",
    "  procedure, env var table, and known failure modes.",
    "",
    bar(),
  ];
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
}

function fail(message, exitCode = 2) {
  process.stderr.write(`\n[acceptance] FAIL: ${message}\n`);
  process.exit(exitCode);
}

function checkPreflight() {
  const artifacts = resolveRepoArtifacts();
  const issues = [];
  if (!existsSync(artifacts.cliBin)) {
    issues.push(
      `polaris CLI binary missing at ${artifacts.cliBin}. Run \`pnpm -r build\` from the repo root before re-running.`,
    );
  }
  // The Node SDK is dynamically imported by the scenario. We don't
  // probe its dist/ here because the scenario test prints a clearer
  // error path; this is a fast wrap-up, not an exhaustive check.
  if (!existsSync(artifacts.runbook)) {
    issues.push(
      `acceptance runbook missing at ${artifacts.runbook}. The scenario asserts its presence as part of step 9.`,
    );
  }
  if ((process.env["DATABASE_URL"] ?? "") === "") {
    issues.push(
      "DATABASE_URL is unset. The acceptance test reads/writes control-plane state through the `polaris` CLI which needs the connection string.",
    );
  }
  return issues;
}

async function main() {
  const version = readRepoVersion();
  const ingesterUrl = process.env["POLARIS_INGESTER_URL"] ?? "http://localhost:8080";
  const projectId = process.env["POLARIS_ACCEPTANCE_PROJECT_ID"] ?? "storefront";
  const environment = process.env["POLARIS_ACCEPTANCE_ENVIRONMENT"] ?? "development";
  const scenarioPath = "tests/acceptance/scenarios/full-pipeline.test.ts";

  printBanner({ version, scenarioPath, ingesterUrl, projectId, environment });

  const preflight = checkPreflight();
  if (preflight.length > 0) {
    process.stderr.write("\n[acceptance] preflight failed:\n");
    for (const issue of preflight) {
      process.stderr.write(`  - ${issue}\n`);
    }
    fail("preflight checks did not pass; see messages above", 2);
    return;
  }

  // Spawn vitest with the gating env var ON. We pass the explicit
  // scenario file path so the run is targeted — if a future task adds
  // another scenario under `tests/acceptance/`, the runner stays
  // deterministic about which one it executes.
  const vitestArgs = ["vitest", "run", "--root", REPO_ROOT, "--reporter=default", scenarioPath];
  const child = spawn("pnpm", ["exec", ...vitestArgs], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      POLARIS_ACCEPTANCE_TEST: "1",
    },
  });

  const code = await new Promise((res) => {
    child.on("exit", (exitCode, signal) => {
      if (exitCode === null && signal !== null) {
        process.stderr.write(`\n[acceptance] vitest terminated by signal ${signal}\n`);
        res(143);
        return;
      }
      res(exitCode ?? 1);
    });
    child.on("error", (err) => {
      process.stderr.write(`\n[acceptance] vitest spawn failed: ${err.message}\n`);
      res(1);
    });
  });

  const status = code === 0 ? "PASS" : "FAIL";
  process.stdout.write(`\n${bar()}\n`);
  process.stdout.write(`${center(`Acceptance verdict: ${status}`)}\n`);
  process.stdout.write(`${bar()}\n`);
  process.exit(code);
}

main().catch((err) => {
  process.stderr.write(`\n[acceptance] unexpected runner error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
