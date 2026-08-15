/**
 * The rebuild driver.
 *
 * `profiles-rebuild.test.ts` pins the ORDER of the four steps. This pins what
 * each one does, and the one with a real failure mode is the pause: flipping
 * the activation row stops the resolver taking NEW work and says nothing
 * about what is already in flight — which is exactly the traffic that would
 * write into the scope about to be emptied.
 */

import { describe, expect, it, vi } from "vitest";

import {
  createMetricsDrainProbe,
  createRebuildDriver,
  type RebuildDriverDeps,
  sumInFlight,
} from "../src/commands/profiles/rebuild-driver.js";
import { buildRegisteredRebuildDriver } from "../src/commands/profiles/rebuild-registration.js";

vi.mock("../src/db/index.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    findActivationByKey: vi.fn(async () => null),
    disableProcessorActivationWithAudit: vi.fn(async () => ({ applied: true })),
    enableProcessorActivationWithAudit: vi.fn(async () => ({ applied: true })),
    truncateProfilePlaneWithAudit: vi.fn(async () => ({
      applied: true,
      counts: { profiles: 3, profile_identifiers: 7, profile_merges: 1, identity_links: 9 },
    })),
  };
});

function deps(overrides: Partial<RebuildDriverDeps> = {}): RebuildDriverDeps {
  let clock = 1_000_000;
  return {
    db: {} as never,
    actor: { source: "operator_token", label: "tester" },
    reason: "over-merge",
    generateAuditId: () => "polaris_aud_test",
    now: () => new Date(clock),
    retentionDays: 90,
    runReplay: async () => {},
    inFlightResolutions: async () => 0,
    recordJob: async () => {},
    sleep: async (ms) => {
      clock += ms;
    },
    ...overrides,
  };
}

const SCOPE = { projectId: "storefront", environment: "staging" };

describe("rebuild driver", () => {
  it("waits for in-flight resolutions before returning from pause", async () => {
    // The activation row stops NEW work only. Returning while resolutions are
    // still landing would let them write into the scope the caller is about
    // to truncate — the precise race the step ordering exists to prevent.
    let remaining = 3;
    const driver = createRebuildDriver(
      deps({
        inFlightResolutions: async () => {
          remaining -= 1;
          return Math.max(0, remaining);
        },
      }),
    );
    await driver.pause(SCOPE);
    expect(remaining).toBeLessThanOrEqual(0);
  });

  it("refuses to proceed when the resolver never drains", async () => {
    // A stuck consumer. Truncating anyway would race the writes the wait
    // exists to exclude; blocking forever would present as a hung rebuild
    // rather than one that says why it stopped. The error says the plane was
    // NOT truncated, because that is the fact the operator needs.
    const driver = createRebuildDriver(deps({ inFlightResolutions: async () => 5 }));
    await expect(driver.pause(SCOPE)).rejects.toThrow(/NOT truncated/);
  });

  it("reports the retention bound from replay", async () => {
    const driver = createRebuildDriver(deps({ retentionDays: 30 }));
    expect(await driver.replay(SCOPE)).toEqual({ retentionDays: 30 });
  });

  it("runs the replay before reporting depth", async () => {
    const order: string[] = [];
    const driver = createRebuildDriver(
      deps({
        runReplay: async () => {
          order.push("replay");
        },
      }),
    );
    await driver.replay(SCOPE);
    expect(order).toEqual(["replay"]);
  });
});

describe("metrics drain probe", () => {
  it("sums in-flight across every series in the scope", async () => {
    // A stage may be labelled per topic family or partition. Any one of
    // those being non-zero means work is still landing in the scope, so the
    // probe sums rather than picking a series.
    const text = [
      'polaris_processor_in_flight{project_id="storefront",environment="staging",partition="0"} 2',
      'polaris_processor_in_flight{project_id="storefront",environment="staging",partition="1"} 3',
      "# HELP something else",
    ].join("\n");
    expect(sumInFlight(text, { projectId: "storefront", environment: "staging" })).toBe(5);
  });

  it("ignores other projects and environments", async () => {
    const text = [
      'polaris_processor_in_flight{project_id="other",environment="staging"} 7',
      'polaris_processor_in_flight{project_id="storefront",environment="production"} 9',
      'polaris_processor_in_flight{project_id="storefront",environment="staging"} 1',
    ].join("\n");
    expect(sumInFlight(text, { projectId: "storefront", environment: "staging" })).toBe(1);
  });

  it("reports zero when the scope has no series at all", async () => {
    // A resolver that has never handled an event for this project publishes
    // no series for it, and that genuinely is drained.
    expect(sumInFlight("", { projectId: "storefront", environment: "staging" })).toBe(0);
  });

  it("THROWS on a failed scrape rather than reading it as drained", async () => {
    // The dangerous default. An unreachable resolver is indistinguishable
    // from a busy one from here; treating "cannot tell" as "drained" would
    // truncate into whatever it is still doing.
    const probe = createMetricsDrainProbe({
      metricsUrl: "http://resolver/metrics",
      fetch: (async () => new Response("nope", { status: 503 })) as typeof globalThis.fetch,
    });
    await expect(probe({ projectId: "storefront", environment: "staging" })).rejects.toThrow(
      /NOT truncated/,
    );
  });
});

describe("registered driver construction", () => {
  it("refuses without the resolver's metrics endpoint", async () => {
    // No default, deliberately. A default would let a rebuild run against
    // whatever answered on localhost, and the one thing the drain probe must
    // never do is report "drained" because it asked the wrong process.
    const ctx = {
      env: {},
      actor: { source: "operator_token", label: "tester" },
      logger: { info: () => {} },
    } as unknown as Parameters<typeof buildRegisteredRebuildDriver>[0];

    expect(() =>
      buildRegisteredRebuildDriver(ctx, {
        projectId: "storefront",
        environment: "staging",
        reason: "over-merge",
      }),
    ).toThrow(/POLARIS_RESOLVER_METRICS_URL is required/);
  });
});
