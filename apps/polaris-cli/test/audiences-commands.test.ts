/**
 * `polaris audiences compute` / `show` (C195TM1C).
 *
 * The runner's semantics are tested in the processor package; these cover
 * the command surface: selection, refusal, and the staleness signal that
 * `show` exists to give.
 */

import { AUDIENCE_DEFINITIONS } from "@polaris/audience-catalog";
import { describe, expect, it } from "vitest";

import { createAudienceEventEmitter } from "../src/commands/audiences/emitter.js";

import {
  type AudiencesComputeRunner,
  type AudiencesShowMember,
  type AudiencesShowStore,
  buildAudiencesComputeRunner,
  buildAudiencesShowRunner,
  type CommandContext,
  type OutputStreams,
  UsageError,
} from "../src/index.js";

function capture(): { streams: OutputStreams; stdout: string[] } {
  const stdout: string[] = [];
  return {
    streams: {
      writeOut: (text) => {
        stdout.push(text);
      },
      writeErr: () => {},
    },
    stdout,
  };
}

function makeContext(streams: OutputStreams, format: "human" | "json" = "json"): CommandContext {
  const noop = () => {};
  return {
    config: {
      profile: "default",
      apiUrl: "https://polaris.example.internal",
      token: "polaris_ot_test",
      tokenEnvName: "POLARIS_TOKEN",
      output: format,
      logLevel: "warn",
      configFilePath: undefined,
    },
    logger: {
      fatal: noop,
      error: noop,
      warn: noop,
      info: noop,
      debug: noop,
      trace: noop,
    } as unknown as CommandContext["logger"],
    output: streams,
    env: {},
    actor: { source: "cli", label: "tester" },
  } as unknown as CommandContext;
}

function recordingRunner() {
  const calls: Array<{ audiences: readonly { key: string }[] }> = [];
  const runner: AudiencesComputeRunner = {
    run: async ({ audiences }) => {
      calls.push({ audiences: audiences.map((a) => ({ key: a.key })) });
      return {
        transitions: 0,
        perAudience: audiences.map((a) => ({
          key: a.key,
          version: a.version,
          members: 0,
          entered: 0,
          exited: 0,
          restamped: 0,
        })),
      };
    },
  };
  return { runner, calls };
}

describe("audiences compute — scope is required", () => {
  it("refuses a missing project", async () => {
    const { streams } = capture();
    const run = buildAudiencesComputeRunner({ runner: () => recordingRunner().runner });
    await expect(run({ env: "production" }, makeContext(streams))).rejects.toBeInstanceOf(
      UsageError,
    );
  });

  it("refuses a missing environment", async () => {
    const { streams } = capture();
    const run = buildAudiencesComputeRunner({ runner: () => recordingRunner().runner });
    await expect(run({ project: "storefront" }, makeContext(streams))).rejects.toBeInstanceOf(
      UsageError,
    );
  });
});

describe("audiences compute — selection", () => {
  it("runs every registered definition by default", async () => {
    const { streams } = capture();
    const { runner, calls } = recordingRunner();
    const run = buildAudiencesComputeRunner({ runner: () => runner });
    await run({ project: "storefront", env: "production" }, makeContext(streams));
    expect(calls[0]?.audiences.map((a) => a.key)).toEqual(AUDIENCE_DEFINITIONS.map((d) => d.key));
  });

  it("narrows to one definition with --audience", async () => {
    const { streams } = capture();
    const { runner, calls } = recordingRunner();
    const run = buildAudiencesComputeRunner({ runner: () => runner });
    await run(
      { project: "storefront", env: "production", audience: "recent_purchasers" },
      makeContext(streams),
    );
    expect(calls[0]?.audiences.map((a) => a.key)).toEqual(["recent_purchasers"]);
  });

  it("refuses an unknown audience instead of running nothing", async () => {
    // A cron line with a typo would otherwise succeed nightly, compute
    // nothing, and report success — green job, stale audience.
    const { streams } = capture();
    const run = buildAudiencesComputeRunner({ runner: () => recordingRunner().runner });
    await expect(
      run(
        { project: "storefront", env: "production", audience: "no_such_audience" },
        makeContext(streams),
      ),
    ).rejects.toBeInstanceOf(UsageError);
  });
});

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

function showStore(members: readonly AudiencesShowMember[], total = members.length) {
  let closed = 0;
  const store: AudiencesShowStore = {
    count: async () => total,
    members: async (limit) => members.slice(0, limit),
    close: async () => {
      closed += 1;
    },
  };
  return { store, closedCount: () => closed };
}

function member(overrides: Partial<AudiencesShowMember> = {}): AudiencesShowMember {
  return {
    profileId: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
    enteredAt: new Date("2026-08-15T00:00:00.000Z"),
    audienceVersion: 1,
    ...overrides,
  };
}

describe("audiences show", () => {
  it("refuses an unknown audience", async () => {
    const { streams } = capture();
    const run = buildAudiencesShowRunner({ openStore: () => showStore([]).store });
    await expect(
      run({ audience: "nope", project: "storefront", env: "production" }, makeContext(streams)),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it("reports the definition and the member count", async () => {
    const { streams, stdout } = capture();
    const run = buildAudiencesShowRunner({ openStore: () => showStore([member()], 42).store });
    await run(
      { audience: "recent_purchasers", project: "storefront", env: "production" },
      makeContext(streams),
    );
    const body = JSON.parse(stdout.join("")) as Record<string, unknown>;
    expect(body.audience).toBe("recent_purchasers");
    expect(body.version).toBe(1);
    expect(body.members).toBe(42);
    expect(body.source).toBe("traits");
  });

  it("closes the store", async () => {
    const { streams } = capture();
    const { store, closedCount } = showStore([member()]);
    const run = buildAudiencesShowRunner({ openStore: () => store });
    await run(
      { audience: "recent_purchasers", project: "storefront", env: "production" },
      makeContext(streams),
    );
    expect(closedCount()).toBe(1);
  });

  it("flags membership left behind by an older definition version", async () => {
    // The failure this exists for: a definition edited but never re-run
    // looks authoritative while describing a population derived under
    // different semantics.
    const { streams, stdout } = capture();
    const run = buildAudiencesShowRunner({
      openStore: () => showStore([member(), member({ audienceVersion: 99 })]).store,
    });
    await run(
      { audience: "recent_purchasers", project: "storefront", env: "production" },
      makeContext(streams),
    );
    const body = JSON.parse(stdout.join("")) as { stale_versions: number[] };
    expect(body.stale_versions).toEqual([99]);
  });

  it("reports no stale versions when every row is current", async () => {
    const { streams, stdout } = capture();
    const run = buildAudiencesShowRunner({ openStore: () => showStore([member()]).store });
    await run(
      { audience: "recent_purchasers", project: "storefront", env: "production" },
      makeContext(streams),
    );
    const body = JSON.parse(stdout.join("")) as { stale_versions: number[] };
    expect(body.stale_versions).toEqual([]);
  });

  it("says so in human output when membership is stale", async () => {
    const { streams, stdout } = capture();
    const run = buildAudiencesShowRunner({
      openStore: () => showStore([member({ audienceVersion: 99 })]).store,
    });
    await run(
      { audience: "recent_purchasers", project: "storefront", env: "production" },
      makeContext(streams, "human"),
    );
    expect(stdout.join("")).toContain("STALE");
    expect(stdout.join("")).toContain("audiences compute");
  });

  it("refuses a limit past the ceiling", async () => {
    const { streams } = capture();
    const run = buildAudiencesShowRunner({ openStore: () => showStore([]).store });
    await expect(
      run(
        { audience: "recent_purchasers", project: "storefront", env: "production", limit: 5000 },
        makeContext(streams),
      ),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it("reports the total even when the list is truncated", async () => {
    const { streams, stdout } = capture();
    const run = buildAudiencesShowRunner({
      openStore: () => showStore([member(), member(), member()], 900).store,
    });
    await run(
      { audience: "recent_purchasers", project: "storefront", env: "production", limit: 2 },
      makeContext(streams),
    );
    const body = JSON.parse(stdout.join("")) as { members: number; shown: unknown[] };
    expect(body.members).toBe(900);
    expect(body.shown).toHaveLength(2);
  });
});

describe("the audience event emitter", () => {
  function recordingProducer() {
    const published: Array<Record<string, unknown>> = [];
    return {
      published,
      producer: {
        publishEvent: async (input: { event: Record<string, unknown> }) => {
          published.push(input.event);
          return { stream: "profile.events-0", partition: 0 };
        },
      } as never,
    };
  }

  it("stamps the profile block, which is what makes a transition deliverable", async () => {
    // The emitter leaves `identity` empty on purpose — a computed fact
    // belongs to a profile, not to an identifier the run never saw. The
    // PROFILE block is the envelope's slot for exactly this, and without
    // it `normalizeForDestination` drops every transition at
    // `no_usable_identity` before any mapper runs.
    const { producer, published } = recordingProducer();
    const emitter = createAudienceEventEmitter({
      producer,
      isolation: { isIsolated: () => false },
      now: () => new Date("2026-08-17T03:00:00.000Z"),
      identities: async () => "cus_9142",
    });

    await emitter.entered({
      projectId: "storefront",
      environment: "production",
      audience: "high_value",
      audienceVersion: 3,
      profileId: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
      reEntry: false,
      runId: "polaris_arun_1",
    });

    expect(published[0]?.["identity"]).toEqual({});
    expect(published[0]?.["profile"]).toEqual({
      profile_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
      canonical_customer_id: "cus_9142",
    });
  });

  it("carries a null customer id rather than omitting the block", async () => {
    // The block still names the profile, so the warehouse and the
    // profile-plane readers get their row; the DESTINATION is what
    // declines to key on an internal id.
    const { producer, published } = recordingProducer();
    const emitter = createAudienceEventEmitter({
      producer,
      isolation: { isIsolated: () => false },
      now: () => new Date("2026-08-17T03:00:00.000Z"),
      identities: async () => null,
    });

    await emitter.exited({
      projectId: "storefront",
      environment: "production",
      audience: "high_value",
      audienceVersion: 3,
      profileId: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
      enteredAt: new Date("2026-07-01T00:00:00.000Z"),
      runId: "polaris_arun_1",
    });

    expect(published[0]?.["profile"]).toMatchObject({ canonical_customer_id: null });
  });

  it("looks a profile up once per run, however many audiences move it", async () => {
    // A run over five audiences moves the same profile up to five times.
    // One query per distinct profile, not per transition.
    const { producer } = recordingProducer();
    let lookups = 0;
    const emitter = createAudienceEventEmitter({
      producer,
      isolation: { isIsolated: () => false },
      now: () => new Date("2026-08-17T03:00:00.000Z"),
      identities: async () => {
        lookups += 1;
        return "cus_9142";
      },
    });

    const base = {
      projectId: "storefront",
      environment: "production",
      audienceVersion: 3,
      profileId: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
      reEntry: false,
      runId: "polaris_arun_1",
    };
    await emitter.entered({ ...base, audience: "high_value" });
    await emitter.entered({ ...base, audience: "churn_risk" });
    await emitter.entered({ ...base, audience: "vip" });

    expect(lookups).toBe(1);
  });

  it("shares one in-flight lookup between concurrent transitions", async () => {
    // Memoized BEFORE the await, so two transitions for one profile do
    // not race two queries.
    const { producer } = recordingProducer();
    let lookups = 0;
    const emitter = createAudienceEventEmitter({
      producer,
      isolation: { isIsolated: () => false },
      now: () => new Date("2026-08-17T03:00:00.000Z"),
      identities: async () => {
        lookups += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return "cus_9142";
      },
    });

    const base = {
      projectId: "storefront",
      environment: "production",
      audienceVersion: 3,
      profileId: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
      reEntry: false,
      runId: "polaris_arun_1",
    };
    await Promise.all([
      emitter.entered({ ...base, audience: "a" }),
      emitter.entered({ ...base, audience: "b" }),
    ]);

    expect(lookups).toBe(1);
  });

  it("emits with a null customer id when the lookup throws", async () => {
    // A failed identity read must not fail the run: membership is already
    // durable, and a transition that reaches the warehouse without a
    // customer id is better than a run that dies half-emitted.
    const { producer, published } = recordingProducer();
    const emitter = createAudienceEventEmitter({
      producer,
      isolation: { isIsolated: () => false },
      now: () => new Date("2026-08-17T03:00:00.000Z"),
      identities: async () => {
        throw new Error("postgres unavailable");
      },
    });

    await emitter.entered({
      projectId: "storefront",
      environment: "production",
      audience: "high_value",
      audienceVersion: 3,
      profileId: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
      reEntry: false,
      runId: "polaris_arun_1",
    });

    expect(published[0]?.["profile"]).toMatchObject({ canonical_customer_id: null });
  });
});
