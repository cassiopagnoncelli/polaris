/**
 * Product acceptance test — P12-003.
 *
 * Drives the canonical Polaris happy path end-to-end through production-
 * shipped surfaces only. This is the release gate the operator runs to
 * answer: "is the platform shipping?"
 *
 * The wrapper is intentionally thin: it sets a generous wall-clock
 * timeout, delegates the work to `runAcceptanceScenario` (which lives
 * in `tests/acceptance/lib/scenario.mjs` so it can be executed without
 * Vitest by `scripts/run-acceptance.mjs`), and then asserts per-step
 * + overall verdict. Each step appears as its own `it` so the Vitest
 * reporter prints PASS / FAIL per pipeline stage and the operator can
 * jump straight to the first red row.
 *
 * Gating pattern (matches `tests/smoke/vertical-slice.test.ts`):
 *
 *   The whole describe block skips unless `POLARIS_ACCEPTANCE_TEST=1`
 *   is set. This keeps the default `pnpm test` (which runs on every
 *   PR) cheap and Docker-free. The runner script in
 *   `scripts/run-acceptance.mjs` flips the env var on and is the
 *   operator entry point invoked as `pnpm test:acceptance`.
 *
 * @see scripts/run-acceptance.mjs
 * @see docs/release/acceptance-test-runbook.md
 * @see docs/development/acceptance-test.md
 */

import { beforeAll, describe, expect, it } from "vitest";

import {
  type AcceptanceStepResult,
  type AcceptanceVerdict,
  runAcceptanceScenario,
} from "../lib/scenario.mjs";

// Generous wall-clock cap: the per-step polls inside the scenario are
// already bounded by POLARIS_ACCEPTANCE_POLL_TIMEOUT_MS (default 60s)
// per ClickHouse / delivery poll, plus the CLI shell-outs and SDK
// flush. 300s covers a cold compose start.
const ACCEPTANCE_TIMEOUT_MS = 300_000;

const SHOULD_RUN = process.env["POLARIS_ACCEPTANCE_TEST"] === "1";

// Step ids we expect the scenario to emit in this exact order. Pinning
// the order here keeps the Vitest report stable across runs and forces
// us to update both files when a new step lands.
const EXPECTED_STEPS = [
  "control_plane_catalog",
  "control_plane_project_config",
  "control_plane_api_key",
  "control_plane_destination",
  "sdk_track",
  "ingestion_accepted",
  "analytics_persisted",
  "delivery_observed",
  "replay_dry_run",
  "release_documentation",
] as const;

interface AcceptanceScenarioOutcome {
  readonly verdict: AcceptanceVerdict;
  readonly results: readonly AcceptanceStepResult[];
}

// Hoist the scenario run into a beforeAll so we execute it exactly
// once per test invocation. Each `it()` looks at the matching row.
// Running the scenario per `it()` would multiply real-world side
// effects (extra API keys, extra replay jobs); we want one tape.
describe.skipIf(!SHOULD_RUN)("product acceptance (full pipeline)", () => {
  let outcome: AcceptanceScenarioOutcome;

  beforeAll(async () => {
    outcome = (await runAcceptanceScenario()) as AcceptanceScenarioOutcome;
  }, ACCEPTANCE_TIMEOUT_MS);

  it("ran every step in the expected order", () => {
    const ids = outcome.results.map((r) => r.id);
    expect(ids).toEqual([...EXPECTED_STEPS]);
  });

  for (const stepId of EXPECTED_STEPS) {
    it(`step "${stepId}" passes (or skips cleanly)`, () => {
      const row = outcome.results.find((r) => r.id === stepId);
      expect(row, `step ${stepId} did not run`).toBeDefined();
      const status = row?.status;
      const errMsg =
        row?.status === "fail" ? `step ${stepId} failed: ${row.error ?? "no error message"}` : "";
      expect(status, errMsg).not.toBe("fail");
    });
  }

  it("emits a verdict of pass", () => {
    expect(outcome.verdict, formatVerdictDiagnostic(outcome)).toBe("pass");
  });
});

function formatVerdictDiagnostic(outcome: AcceptanceScenarioOutcome): string {
  const failing = outcome.results.filter((r) => r.status === "fail");
  if (failing.length === 0) return "no failing steps";
  return failing.map((r) => `- ${r.id}: ${r.error ?? "no error"}`).join("\n");
}
