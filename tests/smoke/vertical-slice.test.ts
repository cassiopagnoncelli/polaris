/**
 * Vertical-slice smoke test — P5-001.
 *
 * Vitest wrapper around `scripts/smoke/vertical-slice.mjs`. The wrapper
 * is intentionally thin:
 *
 *   - the heavy lifting lives in the script so a fresh checkout can run
 *     `pnpm smoke:vertical-slice` without Vitest
 *   - this test only exists so the CI integration workflow has a single
 *     `pnpm test:smoke` entry point and so vitest's reporting (failure
 *     summary, timeout enforcement, retry policy) covers the smoke run.
 *
 * The whole file SKIPS unless `POLARIS_SMOKE_DOCKER=1` is set. That
 * keeps the default `pnpm test` (executed on every PR) cheap and free
 * of Docker requirements; the integration workflow flips the env var on
 * after bringing up the service matrix.
 *
 * @see scripts/smoke/vertical-slice.mjs
 * @see docs/implementation/runbooks/vertical-slice-smoke.md
 */

import { describe, expect, it } from "vitest";

import { runVerticalSliceSmoke } from "../../scripts/smoke/vertical-slice.mjs";

/**
 * Total wall-clock time the test allows the smoke runner to take.
 * Generous because the polling step inside the runner is itself bounded
 * by POLARIS_SMOKE_POLL_TIMEOUT_MS (default 60s) plus the setup +
 * teardown overhead.
 */
const SMOKE_TEST_TIMEOUT_MS = 120_000;

const SHOULD_RUN = process.env["POLARIS_SMOKE_DOCKER"] === "1";

describe("vertical-slice smoke", () => {
  it.skipIf(!SHOULD_RUN)(
    "sends one checkout.started v1 event end-to-end and observes it in analytics_raw",
    async () => {
      const result = await runVerticalSliceSmoke();

      expect(result.event).toBe("checkout.started");
      expect(result.schemaVersion).toBe(1);
      // NOT a processor-name equality. This asserted
      // `analytics-projector` — the legacy fan-out R-programme exists to
      // retire — so the repo's only end-to-end test spent three days
      // confirming the thing being deleted still worked, while both spine
      // stages threw on every event they saw.
      //
      // A resolved profile_id is the better assertion: minting one is the
      // identity stage's entire job and nothing on the legacy path can
      // produce one, so a populated value is proof of the crossing rather
      // than a string a passthrough could echo.
      expect(result.profileId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(result.processor.name).not.toBe("analytics-projector");
      expect(result.projectId).toBe(process.env["POLARIS_SMOKE_PROJECT_ID"] ?? "storefront");
      expect(result.environment).toBe(process.env["POLARIS_SMOKE_ENVIRONMENT"] ?? "development");
      expect(result.eventId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    },
    SMOKE_TEST_TIMEOUT_MS,
  );
});
