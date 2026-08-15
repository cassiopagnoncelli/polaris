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
  createRebuildDriver,
  type RebuildDriverDeps,
} from "../src/commands/profiles/rebuild-driver.js";

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
