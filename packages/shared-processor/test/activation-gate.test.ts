/**
 * Tests for the activation gate.
 *
 * The properties that matter operationally:
 *
 *   - an explicit `disabled` row stops the processor for that scope,
 *   - no row means allowed, so a new project is never silently dropped,
 *   - a disable is scoped to its (project, environment), not global,
 *   - answers are cached for the TTL, then re-read, so a re-enable lands
 *     without a redeploy,
 *   - concurrent misses share one query rather than stampeding,
 *   - a database failure fails OPEN — losing the control plane must not
 *     stop the event pipeline.
 */
import { describe, expect, it, vi } from "vitest";

import {
  type ActivationStateReader,
  ALWAYS_ENABLED_GATE,
  createProcessorActivationGate,
} from "../src/activation-gate.js";

const IDENTITY = { name: "analytics-projector", version: "v1" } as const;
const SCOPE = { project_id: "storefront", environment: "development" } as const;

function fakeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  };
}

function gateOver(read: ActivationStateReader, overrides: { now?: () => number } = {}) {
  const logger = fakeLogger();
  return {
    logger,
    gate: createProcessorActivationGate({
      identity: IDENTITY,
      read,
      logger: logger as never,
      ...(overrides.now !== undefined ? { now: overrides.now } : {}),
    }),
  };
}

describe("createProcessorActivationGate", () => {
  it("closes on an explicit disabled row", async () => {
    const { gate } = gateOver(async () => "disabled");
    expect(await gate.isEnabled(SCOPE)).toBe(false);
  });

  it("opens on an explicit enabled row", async () => {
    const { gate } = gateOver(async () => "enabled");
    expect(await gate.isEnabled(SCOPE)).toBe(true);
  });

  it("opens when no row exists", async () => {
    // The default-allow decision: a project nobody has activated still
    // flows. Default-deny would make every new project silent data loss.
    const { gate } = gateOver(async () => null);
    expect(await gate.isEnabled(SCOPE)).toBe(true);
  });

  it("scopes a disable to its own (project, environment)", async () => {
    const read: ActivationStateReader = async (scope) =>
      scope.project_id === "storefront" && scope.environment === "production" ? "disabled" : null;
    const { gate } = gateOver(read);

    expect(await gate.isEnabled({ project_id: "storefront", environment: "production" })).toBe(
      false,
    );
    expect(await gate.isEnabled({ project_id: "storefront", environment: "development" })).toBe(
      true,
    );
    expect(await gate.isEnabled({ project_id: "payments", environment: "production" })).toBe(true);
  });

  it("serves the cache within the TTL and re-reads after it", async () => {
    let state: string | null = "disabled";
    let reads = 0;
    let clock = 1_000;
    const { gate } = gateOver(
      async () => {
        reads += 1;
        return state;
      },
      { now: () => clock },
    );

    expect(await gate.isEnabled(SCOPE)).toBe(false);
    expect(await gate.isEnabled(SCOPE)).toBe(false);
    expect(reads).toBe(1);

    // Operator re-enables. The gate must pick it up on its own — an
    // operator should not have to redeploy a processor to undo a disable.
    state = "enabled";
    clock += 10_001;
    expect(await gate.isEnabled(SCOPE)).toBe(true);
    expect(reads).toBe(2);
  });

  it("collapses concurrent misses into a single query", async () => {
    let reads = 0;
    let release: (value: string | null) => void = () => {};
    const read: ActivationStateReader = () => {
      reads += 1;
      return new Promise<string | null>((resolve) => {
        release = resolve;
      });
    };
    const { gate } = gateOver(read);

    const all = Promise.all([gate.isEnabled(SCOPE), gate.isEnabled(SCOPE), gate.isEnabled(SCOPE)]);
    release("disabled");
    expect(await all).toEqual([false, false, false]);
    expect(reads).toBe(1);
  });

  it("fails open when the lookup throws and nothing is cached", async () => {
    const { gate, logger } = gateOver(async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:5432");
    });
    expect(await gate.isEnabled(SCOPE)).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("serves the last known answer when the lookup starts failing", async () => {
    let fail = false;
    let clock = 1_000;
    const { gate } = gateOver(
      async () => {
        if (fail) throw new Error("connection terminated");
        return "disabled";
      },
      { now: () => clock },
    );

    expect(await gate.isEnabled(SCOPE)).toBe(false);

    fail = true;
    clock += 10_001;
    // A disable already in force stays in force across an outage; it does
    // not silently flip back on.
    expect(await gate.isEnabled(SCOPE)).toBe(false);
  });

  it("retries the query on the next call rather than caching the failure", async () => {
    let fail = true;
    let reads = 0;
    const { gate } = gateOver(async () => {
      reads += 1;
      if (fail) throw new Error("connection terminated");
      return "disabled";
    });

    expect(await gate.isEnabled(SCOPE)).toBe(true);
    fail = false;
    expect(await gate.isEnabled(SCOPE)).toBe(false);
    expect(reads).toBe(2);
  });

  it("requires either a db or a reader", () => {
    expect(() =>
      createProcessorActivationGate({ identity: IDENTITY, logger: fakeLogger() as never }),
    ).toThrow(/needs either `db` or `read`/);
  });
});

describe("ALWAYS_ENABLED_GATE", () => {
  it("allows every scope, so a transform test needs no database", async () => {
    expect(await ALWAYS_ENABLED_GATE.isEnabled(SCOPE)).toBe(true);
    expect(
      await ALWAYS_ENABLED_GATE.isEnabled({ project_id: "any", environment: "production" }),
    ).toBe(true);
  });
});
