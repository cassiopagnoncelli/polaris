import { describe, expect, it } from "vitest";

import {
  declareComponentQueues,
  declareSuperStream,
  declareTopologyOnChannel,
  defaultSuperStreams,
  diagnosticsSuperStream,
  IDENTIFIED_EVENTS_RETENTION_DAYS,
} from "../src/topology.js";
import { FakeChannel, testRabbitmqConfig } from "./fakes.js";

describe("declareSuperStream", () => {
  it("declares a direct exchange fronting N partition streams", async () => {
    const channel = new FakeChannel();
    await declareSuperStream(channel.asChannel(), {
      family: "raw.events",
      partitions: 3,
      retentionDays: 90,
      maxLengthBytes: 1024,
    });

    expect(channel.exchanges).toEqual([
      { exchange: "raw.events", type: "direct", options: { durable: true } },
    ]);
    expect(channel.queues.map((q) => q.queue)).toEqual([
      "raw.events-0",
      "raw.events-1",
      "raw.events-2",
    ]);
    // The layout must match `rabbitmq-streams add_super_stream` exactly:
    // routing key is the partition index as a string.
    expect(channel.bindings).toEqual([
      { queue: "raw.events-0", exchange: "raw.events", pattern: "0" },
      { queue: "raw.events-1", exchange: "raw.events", pattern: "1" },
      { queue: "raw.events-2", exchange: "raw.events", pattern: "2" },
    ]);
  });

  it("declares streams with both an age and a size bound", async () => {
    const channel = new FakeChannel();
    await declareSuperStream(channel.asChannel(), {
      family: "analytics.events",
      partitions: 1,
      retentionDays: 30,
      maxLengthBytes: 2048,
    });

    expect(channel.queues[0]?.options).toEqual({
      durable: true,
      arguments: {
        "x-queue-type": "stream",
        "x-max-age": "30D",
        // Without a size bound a spike inside the retention window can
        // fill the disk, which blocks publishes cluster-wide.
        "x-max-length-bytes": 2048,
      },
    });
  });
});

describe("declareComponentQueues", () => {
  it("declares tiered retry queues that dead-letter into redelivery", async () => {
    const channel = new FakeChannel();
    await declareComponentQueues(channel.asChannel(), "meta-capi");

    const byName = new Map(channel.queues.map((q) => [q.queue, q.options]));
    expect([...byName.keys()]).toEqual([
      "meta-capi.dlq",
      "meta-capi.redeliver",
      "meta-capi.retry.5000",
      "meta-capi.retry.30000",
      "meta-capi.retry.120000",
      "meta-capi.retry.600000",
      "meta-capi.retry.1800000",
    ]);

    expect(byName.get("meta-capi.retry.30000")).toEqual({
      durable: true,
      arguments: {
        "x-queue-type": "quorum",
        "x-overflow": "reject-publish",
        "x-dead-letter-strategy": "at-least-once",
        // The delay is the broker's job: queue-level TTL per tier, so
        // expiry order equals arrival order within the tier.
        "x-message-ttl": 30_000,
        "x-dead-letter-exchange": "meta-capi.retry.dlx",
        "x-dead-letter-routing-key": "meta-capi.redeliver",
      },
    });
  });

  it("dead-letters the redelivery queue into the DLQ so poison messages survive", async () => {
    const channel = new FakeChannel();
    await declareComponentQueues(channel.asChannel(), "ga4");

    const redeliver = channel.queues.find((q) => q.queue === "ga4.redeliver");
    expect(redeliver?.options).toMatchObject({
      arguments: {
        "x-dead-letter-exchange": "ga4.retry.dlx",
        "x-dead-letter-routing-key": "ga4.dlq",
      },
    });
    expect(channel.bindings).toEqual([
      { queue: "ga4.dlq", exchange: "ga4.retry.dlx", pattern: "ga4.dlq" },
      { queue: "ga4.redeliver", exchange: "ga4.retry.dlx", pattern: "ga4.redeliver" },
    ]);
  });

  it("leaves the DLQ terminal", async () => {
    const channel = new FakeChannel();
    await declareComponentQueues(channel.asChannel(), "braze");

    const dlq = channel.queues.find((q) => q.queue === "braze.dlq");
    expect(dlq?.options).toEqual({
      durable: true,
      arguments: {
        "x-queue-type": "quorum",
        "x-overflow": "reject-publish",
        "x-dead-letter-strategy": "at-least-once",
      },
    });
  });
});

describe("defaultSuperStreams", () => {
  it("covers every canonical family, and nothing else", () => {
    const specs = defaultSuperStreams(testRabbitmqConfig);
    expect(specs.map((s) => s.family)).toEqual([
      "raw.events",
      "identified.events",
      "resolved.events",
      "profile.events",
      "identity.events",
      "enriched.events",
      "session.events",
      "attribution.events",
      "analytics.events",
    ]);
  });

  it("caps identified.events retention short, since it is regenerable", () => {
    // It sits between the two spine stages and is reproducible by
    // replaying raw.events through the identity stage, so holding it for
    // the raw window would reserve disk for recoverable data. Nothing
    // replays from it — raw.events stays the only replay anchor.
    const specs = defaultSuperStreams(testRabbitmqConfig);
    const identified = specs.find((s) => s.family === "identified.events");
    const raw = specs.find((s) => s.family === "raw.events");
    expect(identified?.retentionDays).toBe(IDENTIFIED_EVENTS_RETENTION_DAYS);
    expect(raw?.retentionDays).toBe(testRabbitmqConfig.streamRetentionDays);
    expect(identified?.retentionDays).toBeLessThan(raw?.retentionDays ?? 0);
  });

  it("never lengthens retention beyond a deliberately short global window", () => {
    // Clamped, not fixed: an operator who shortens the global window is
    // not silently overridden upward for this family.
    const tight = { ...testRabbitmqConfig, streamRetentionDays: 2 };
    const identified = defaultSuperStreams(tight).find((s) => s.family === "identified.events");
    expect(identified?.retentionDays).toBe(2);
  });

  it("leaves the diagnostics stream undeclared until something produces to it", () => {
    // Reserving disk and putting a permanently-empty stream on every
    // dashboard teaches operators to ignore idle streams.
    const specs = defaultSuperStreams(testRabbitmqConfig);
    expect(specs.map((s) => s.family)).not.toContain("polaris.diagnostics.events");

    // The spec still exists for whoever ships the feature.
    const diagnostics = diagnosticsSuperStream(testRabbitmqConfig);
    expect(diagnostics.family).toBe("polaris.diagnostics.events");
    expect(diagnostics.retentionDays).toBe(7);
  });

  it("honours per-family width overrides", () => {
    const specs = defaultSuperStreams({
      ...testRabbitmqConfig,
      partitions: 3,
      partitionOverrides: { "raw.events": 6 },
      streamRetentionDays: 90,
    });
    const raw = specs.find((s) => s.family === "raw.events");
    const analytics = specs.find((s) => s.family === "analytics.events");
    expect(raw?.partitions).toBe(6);
    expect(raw?.retentionDays).toBe(90);
    expect(analytics?.partitions).toBe(3);
  });
});

describe("declareTopologyOnChannel", () => {
  it("declares streams and component queues on one channel", async () => {
    const channel = new FakeChannel();
    await declareTopologyOnChannel(channel.asChannel(), {
      superStreams: [{ family: "raw.events", partitions: 1, retentionDays: 90, maxLengthBytes: 1 }],
      components: [{ component: "sessionizer" }],
    });

    expect(channel.queues.map((q) => q.queue)).toContain("raw.events-0");
    expect(channel.queues.map((q) => q.queue)).toContain("sessionizer.retry.5000");
  });
});
