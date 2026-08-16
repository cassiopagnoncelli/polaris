/**
 * `polaris events tail` (V3L2TLWC).
 *
 * This is the one command in the pair that displays event data, so the
 * tests that matter are the ones that prove it cannot display the wrong
 * thing: policy redaction runs before truncation, an unparseable payload
 * is withheld rather than dumped, and a payload the policy would reject
 * outright is never shown at all.
 */

import type { StreamRangeEvent } from "@polaris/shared-transport";
import { describe, expect, it } from "vitest";

import {
  buildEventsTailRunner,
  type CommandContext,
  DEFAULT_MAX_PAYLOAD_BYTES,
  type EventsTailArgs,
  MAX_PAYLOAD_BYTES_CEILING,
  type OutputStreams,
  type TailedEvent,
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

function event(payload: unknown, overrides: Partial<StreamRangeEvent> = {}): StreamRangeEvent {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    stream: "resolved.events-0",
    partition: 0,
    offset: "42",
    event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
    event_name: "page.viewed",
    project_id: "storefront",
    environment: "production",
    occurred_at: "2026-08-16T10:00:00.000Z",
    partition_key: "profile-1",
    value: new TextEncoder().encode(body),
    headers: {},
    ...overrides,
  };
}

async function runTail(events: readonly StreamRangeEvent[], args: Partial<EventsTailArgs> = {}) {
  const { streams, stdout } = capture();
  const ctx = makeContext(streams);
  const seenStreams: string[][] = [];
  const runner = buildEventsTailRunner({
    signal: new AbortController().signal,
    follow: async ({ streams: s, onEvent }) => {
      seenStreams.push([...s]);
      for (const e of events) onEvent(e);
    },
  });
  await runner({ family: "resolved.events", project: "storefront", ...args }, ctx);
  const shown = stdout.map((line) => JSON.parse(line) as TailedEvent);
  return { shown, stdout, seenStreams };
}

describe("events tail — argument validation", () => {
  it("refuses an unknown stream family", async () => {
    const { streams } = capture();
    const runner = buildEventsTailRunner({ follow: async () => {} });
    await expect(
      runner({ family: "not.a.family", project: "storefront" }, makeContext(streams)),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it("refuses an empty project", async () => {
    const { streams } = capture();
    const runner = buildEventsTailRunner({ follow: async () => {} });
    await expect(
      runner({ family: "resolved.events", project: "  " }, makeContext(streams)),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it("refuses a max-bytes past the ceiling", async () => {
    const { streams } = capture();
    const runner = buildEventsTailRunner({ follow: async () => {} });
    await expect(
      runner(
        {
          family: "resolved.events",
          project: "storefront",
          maxBytes: MAX_PAYLOAD_BYTES_CEILING + 1,
        },
        makeContext(streams),
      ),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it("refuses a non-positive partition count", async () => {
    const { streams } = capture();
    const runner = buildEventsTailRunner({ follow: async () => {} });
    await expect(
      runner(
        { family: "resolved.events", project: "storefront", partitions: 0 },
        makeContext(streams),
      ),
    ).rejects.toBeInstanceOf(UsageError);
  });
});

describe("events tail — stream selection", () => {
  it("attaches to every partition stream of the family", async () => {
    const { seenStreams } = await runTail([], { partitions: 3 });
    expect(seenStreams[0]).toEqual(["resolved.events-0", "resolved.events-1", "resolved.events-2"]);
  });
});

describe("events tail — scope filtering", () => {
  it("drops events from another project", async () => {
    const { shown } = await runTail([
      event({ a: 1 }, { project_id: "other-project" }),
      event({ a: 2 }),
    ]);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.project_id).toBe("storefront");
  });

  it("drops events from another environment when --env is given", async () => {
    const { shown } = await runTail(
      [event({ a: 1 }, { environment: "staging" }), event({ a: 2 })],
      { environment: "production" },
    );
    expect(shown).toHaveLength(1);
    expect(shown[0]?.environment).toBe("production");
  });

  it("shows every environment when --env is omitted", async () => {
    const { shown } = await runTail([event({ a: 1 }, { environment: "staging" }), event({ a: 2 })]);
    expect(shown).toHaveLength(2);
  });
});

describe("events tail — payload redaction", () => {
  it("redacts a field the project's override names", async () => {
    // `checkout` is the sample override project; it redacts
    // `properties.email`. The registry is loaded for real here — the
    // same map the ingester and the destination pass use.
    const { shown, stdout } = await runTail(
      [
        event(
          { project_id: "checkout", properties: { email: "shopper@example.com", path: "/" } },
          { project_id: "checkout" },
        ),
      ],
      { project: "checkout" },
    );
    expect(shown).toHaveLength(1);
    expect(stdout.join("")).not.toContain("shopper@example.com");
    expect(shown[0]?.payload).toContain("[REDACTED:");
    // Non-sensitive fields survive — a tail that showed nothing would be
    // as useless as one that showed everything.
    expect(shown[0]?.payload).toContain('"path":"/"');
  });

  it("leaves the payload alone for a project with no override", async () => {
    const { shown } = await runTail([event({ properties: { path: "/", title: "Home" } })]);
    expect(shown[0]?.payload).toContain('"title":"Home"');
    expect(shown[0]?.payload).not.toContain("[REDACTED:");
  });

  it("redacts a platform-default pattern regardless of project", async () => {
    // A Luhn-valid PAN in a free-form field is a platform-level redaction,
    // so it applies to a project that wrote no override at all.
    const { shown, stdout } = await runTail([event({ properties: { note: "4242424242424242" } })]);
    expect(stdout.join("")).not.toContain("4242424242424242");
    expect(shown[0]?.payload).toContain("[REDACTED:");
  });

  it("withholds a payload the policy would reject outright", async () => {
    // `password` is a platform-level REJECT field. An event carrying one
    // should never have reached the stream, but if one is there the tail
    // must not be the thing that displays it.
    const { shown, stdout } = await runTail([event({ properties: { password: "hunter2" } })]);
    expect(stdout.join("")).not.toContain("hunter2");
    expect(shown[0]?.payload).toContain("withheld");
    expect(shown[0]?.payload).toContain("policy rejects field");
  });

  it("withholds an unparseable payload instead of printing raw bytes", async () => {
    const { shown, stdout } = await runTail([event("this is not json at all")]);
    expect(stdout.join("")).not.toContain("this is not json at all");
    expect(shown[0]?.payload).toContain("unparseable payload withheld");
  });

  it("withholds a non-object payload", async () => {
    const { shown } = await runTail([event("[1,2,3]")]);
    expect(shown[0]?.payload).toContain("non-object payload withheld");
  });
});

describe("events tail — truncation", () => {
  it("cuts an oversized payload and flags it", async () => {
    const { shown } = await runTail([event({ properties: { blob: "x".repeat(5000) } })], {
      maxBytes: 128,
    });
    expect(shown[0]?.truncated).toBe(true);
    expect(shown[0]?.payload.length).toBeLessThanOrEqual(129);
  });

  it("leaves a small payload whole", async () => {
    const { shown } = await runTail([event({ properties: { path: "/" } })]);
    expect(shown[0]?.truncated).toBe(false);
    expect(shown[0]?.payload).not.toContain("…");
  });

  it("defaults to the documented byte cap", async () => {
    const { shown } = await runTail([event({ properties: { blob: "y".repeat(9000) } })]);
    expect(shown[0]?.truncated).toBe(true);
    expect(shown[0]?.payload.length).toBeLessThanOrEqual(DEFAULT_MAX_PAYLOAD_BYTES + 1);
  });

  it("redacts before it truncates", async () => {
    // Order matters: cutting first can slice a payload mid-field and
    // leave a partial value the evaluator no longer recognises.
    const { stdout } = await runTail(
      [
        event(
          {
            project_id: "checkout",
            properties: { email: "shopper@example.com", blob: "z".repeat(4000) },
          },
          { project_id: "checkout" },
        ),
      ],
      { project: "checkout", maxBytes: 4096 },
    );
    expect(stdout.join("")).not.toContain("shopper@example.com");
  });
});

describe("events tail — detach", () => {
  it("stops after --max-events", async () => {
    const { shown } = await runTail([event({ a: 1 }), event({ a: 2 }), event({ a: 3 })], {
      maxEvents: 2,
    });
    expect(shown).toHaveLength(2);
  });
});

describe("events tail — human output", () => {
  it("prints the lineage line and the payload", async () => {
    const { streams, stdout } = capture();
    const runner = buildEventsTailRunner({
      signal: new AbortController().signal,
      follow: async ({ onEvent }) => {
        onEvent(event({ properties: { path: "/" } }));
      },
    });
    await runner(
      { family: "resolved.events", project: "storefront" },
      makeContext(streams, "human"),
    );
    const text = stdout.join("");
    expect(text).toContain("resolved.events-0[0]@42");
    expect(text).toContain("page.viewed");
    expect(text).toContain("storefront/production");
  });
});
