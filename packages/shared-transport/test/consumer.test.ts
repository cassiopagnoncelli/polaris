import { describe, expect, it } from "vitest";

import { InMemoryCheckpointStore } from "../src/checkpoints.js";
import { createPolarisConsumer, offsetSpec } from "../src/consumer.js";
import type { TransportMessagePayload } from "../src/types.js";
import { FakeConnection, streamDelivery, testRabbitmqConfig } from "./fakes.js";

/** Let the consumer's per-partition promise chain drain. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("offsetSpec", () => {
  it("resumes at checkpoint + 1 so the handled message is not re-processed", () => {
    expect(offsetSpec("41", "next")).toEqual({ "!": "long", value: "42" });
  });

  it("uses the configured start position when there is no checkpoint", () => {
    expect(offsetSpec(undefined, "next")).toBe("next");
    expect(offsetSpec(undefined, "first")).toBe("first");
  });

  it("survives offsets beyond 32-bit range", () => {
    // A bare JS number would be encoded as a 32-bit int by amqplib and
    // silently truncate.
    expect(offsetSpec("4294967300", "next")).toEqual({ "!": "long", value: "4294967301" });
  });
});

describe("createPolarisConsumer", () => {
  it("expands families into one reader per assigned partition", async () => {
    const connection = new FakeConnection({
      ...testRabbitmqConfig,
      partitions: 3,
      assignedPartitions: [0, 2],
    });
    const consumer = createPolarisConsumer({
      connection: connection.asConnection(),
      groupName: "sessionizer-v1",
      checkpoints: new InMemoryCheckpointStore(),
    });

    await consumer.subscribe({ families: ["raw.events"], queues: ["sessionizer.redeliver"] });

    expect(consumer.streams).toEqual(["raw.events-0", "raw.events-2"]);
    expect(consumer.queues).toEqual(["sessionizer.redeliver"]);
  });

  it("owns every partition when no assignment is configured", async () => {
    const connection = new FakeConnection({ ...testRabbitmqConfig, partitions: 3 });
    const consumer = createPolarisConsumer({
      connection: connection.asConnection(),
      groupName: "g",
      checkpoints: new InMemoryCheckpointStore(),
    });
    await consumer.subscribe({ families: ["analytics.events"] });
    expect(consumer.streams).toEqual([
      "analytics.events-0",
      "analytics.events-1",
      "analytics.events-2",
    ]);
  });

  it("rejects an assignment outside the family's width", async () => {
    const connection = new FakeConnection({ ...testRabbitmqConfig, partitions: 2 });
    const consumer = createPolarisConsumer({
      connection: connection.asConnection(),
      groupName: "g",
      checkpoints: new InMemoryCheckpointStore(),
    });
    await expect(consumer.subscribe({ families: ["raw.events"], partitions: [5] })).rejects.toThrow(
      /outside/,
    );
  });

  it("attaches each stream at its stored checkpoint and one channel per partition", async () => {
    const connection = new FakeConnection({ ...testRabbitmqConfig, partitions: 2 });
    const checkpoints = new InMemoryCheckpointStore();
    await checkpoints.write({ group_name: "g", stream: "raw.events-1", last_offset: "99" });

    const consumer = createPolarisConsumer({
      connection: connection.asConnection(),
      groupName: "g",
      checkpoints,
    });
    await consumer.subscribe({ families: ["raw.events"] });
    await consumer.runEach(async () => undefined);

    expect(connection.channels).toHaveLength(2);
    expect(connection.channels[0]?.consumes[0]).toEqual({
      queue: "raw.events-0",
      options: { noAck: false, arguments: { "x-stream-offset": "next" } },
    });
    expect(connection.channels[1]?.consumes[0]).toEqual({
      queue: "raw.events-1",
      options: { noAck: false, arguments: { "x-stream-offset": { "!": "long", value: "100" } } },
    });
    expect(connection.channels[0]?.prefetchCount).toBe(testRabbitmqConfig.prefetch);
    await consumer.disconnect();
  });

  it("projects deliveries onto the broker-neutral payload", async () => {
    const connection = new FakeConnection({ ...testRabbitmqConfig, partitions: 1 });
    const consumer = createPolarisConsumer({
      connection: connection.asConnection(),
      groupName: "g",
      checkpoints: new InMemoryCheckpointStore(),
    });
    const seen: TransportMessagePayload[] = [];
    await consumer.subscribe({ families: ["raw.events"] });
    await consumer.runEach(async (payload) => {
      seen.push(payload);
    });

    connection.channels[0]?.deliver(
      streamDelivery({
        offset: 7,
        messageId: "project:env:cust",
        body: '{"event_id":"e1"}',
        headers: { "polaris-event-id": "e1", "polaris-project-id": "project-alpha" },
      }),
    );
    await settle();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.stream).toBe("raw.events-0");
    expect(seen[0]?.family).toBe("raw.events");
    expect(seen[0]?.partition).toBe(0);
    expect(seen[0]?.message.offset).toBe("7");
    expect(seen[0]?.message.key).toBe("project:env:cust");
    expect(seen[0]?.message.value?.toString("utf8")).toBe('{"event_id":"e1"}');
    await consumer.disconnect();
  });

  it("hands the handler the Polaris header context", async () => {
    const connection = new FakeConnection({ ...testRabbitmqConfig, partitions: 1 });
    const consumer = createPolarisConsumer({
      connection: connection.asConnection(),
      groupName: "g",
      checkpoints: new InMemoryCheckpointStore(),
    });
    let context: Record<string, string> | undefined;
    await consumer.subscribe({ families: ["raw.events"] });
    await consumer.runEach(async (_payload, ctx) => {
      context = ctx as Record<string, string>;
    });

    connection.channels[0]?.deliver(
      streamDelivery({
        offset: 1,
        headers: {
          "polaris-event-id": "e1",
          "polaris-project-id": "project-alpha",
          "polaris-environment": "production",
          "polaris-topic-family": "raw.events",
        },
      }),
    );
    await settle();

    expect(context).toEqual({
      event_id: "e1",
      project_id: "project-alpha",
      environment: "production",
      topic_family: "raw.events",
    });
    await consumer.disconnect();
  });

  it("handles a partition's messages strictly in order", async () => {
    const connection = new FakeConnection({ ...testRabbitmqConfig, partitions: 1 });
    const consumer = createPolarisConsumer({
      connection: connection.asConnection(),
      groupName: "g",
      checkpoints: new InMemoryCheckpointStore(),
    });
    const order: string[] = [];
    await consumer.subscribe({ families: ["raw.events"] });
    await consumer.runEach(async (payload) => {
      order.push(`start:${payload.message.offset}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end:${payload.message.offset}`);
    });

    const channel = connection.channels[0];
    channel?.deliver(streamDelivery({ offset: 1 }));
    channel?.deliver(streamDelivery({ offset: 2 }));
    await new Promise((resolve) => setTimeout(resolve, 40));

    // Per-identity ordering is the whole point of the partition key; a
    // handler must never be re-entered for the same partition.
    expect(order).toEqual(["start:1", "end:1", "start:2", "end:2"]);
    await consumer.disconnect();
  });

  it("acks and advances the checkpoint only after the handler succeeds", async () => {
    const connection = new FakeConnection({
      ...testRabbitmqConfig,
      partitions: 1,
      checkpointEvery: 1,
    });
    const checkpoints = new InMemoryCheckpointStore();
    const consumer = createPolarisConsumer({
      connection: connection.asConnection(),
      groupName: "g",
      checkpoints,
    });
    await consumer.subscribe({ families: ["raw.events"] });
    await consumer.runEach(async () => undefined);

    connection.channels[0]?.deliver(streamDelivery({ offset: 12 }));
    await settle();

    expect(connection.channels[0]?.acked).toHaveLength(1);
    expect(await checkpoints.read("g", "raw.events-0")).toBe("12");
    await consumer.disconnect();
  });

  it("does not checkpoint a message whose handler threw", async () => {
    const connection = new FakeConnection({
      ...testRabbitmqConfig,
      partitions: 1,
      checkpointEvery: 1,
    });
    const checkpoints = new InMemoryCheckpointStore();
    await checkpoints.write({ group_name: "g", stream: "raw.events-0", last_offset: "4" });
    const consumer = createPolarisConsumer({
      connection: connection.asConnection(),
      groupName: "g",
      checkpoints,
      retryDelayMs: 5,
    });
    await consumer.subscribe({ families: ["raw.events"] });
    await consumer.runEach(async () => {
      throw new Error("handler blew up");
    });

    connection.channels[0]?.deliver(streamDelivery({ offset: 5 }));
    await new Promise((resolve) => setTimeout(resolve, 40));

    // At-least-once: the offset must stay where it was so the message is
    // redelivered rather than skipped.
    expect(await checkpoints.read("g", "raw.events-0")).toBe("4");
    expect(connection.channels[0]?.acked).toHaveLength(0);
    await consumer.disconnect();
  });

  it("rewinds to the checkpoint by re-attaching after a handler failure", async () => {
    const connection = new FakeConnection({
      ...testRabbitmqConfig,
      partitions: 1,
      checkpointEvery: 1,
    });
    const checkpoints = new InMemoryCheckpointStore();
    const consumer = createPolarisConsumer({
      connection: connection.asConnection(),
      groupName: "g",
      checkpoints,
      retryDelayMs: 5,
    });
    let calls = 0;
    await consumer.subscribe({ families: ["raw.events"] });
    await consumer.runEach(async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
    });

    connection.channels[0]?.deliver(streamDelivery({ offset: 3 }));
    await new Promise((resolve) => setTimeout(resolve, 60));

    // A second channel means the reader detached and re-attached; the
    // stream position is the checkpoint, so offset 3 comes back.
    expect(connection.channels.length).toBeGreaterThanOrEqual(2);
    expect(connection.channels[0]?.closed).toBe(true);
    await consumer.disconnect();
  });

  it("requeues a failed queue delivery instead of rewinding", async () => {
    const connection = new FakeConnection({ ...testRabbitmqConfig, partitions: 1 });
    const consumer = createPolarisConsumer({
      connection: connection.asConnection(),
      groupName: "g",
      checkpoints: new InMemoryCheckpointStore(),
    });
    await consumer.subscribe({ families: [], queues: ["ga4.redeliver"] });
    await consumer.runEach(async () => {
      throw new Error("still failing");
    });

    connection.channels[0]?.deliver(streamDelivery({ offset: 0, deliveryTag: 9 }));
    await settle();

    // Quorum queues carry a delivery limit and dead-letter poison
    // messages, so a bounded requeue is the right move here.
    expect(connection.channels[0]?.nacked).toEqual([{ message: expect.anything(), requeue: true }]);
    await consumer.disconnect();
  });

  it("re-attaches every reader at its checkpoint after a reconnect", async () => {
    const connection = new FakeConnection({
      ...testRabbitmqConfig,
      partitions: 1,
      checkpointEvery: 1,
    });
    const checkpoints = new InMemoryCheckpointStore();
    const consumer = createPolarisConsumer({
      connection: connection.asConnection(),
      groupName: "g",
      checkpoints,
    });
    await consumer.subscribe({ families: ["raw.events"] });
    await consumer.runEach(async () => undefined);

    connection.channels[0]?.deliver(streamDelivery({ offset: 20 }));
    await settle();
    await connection.fireReconnect();

    // The whole reason the driver supervises its own connection: amqplib's
    // built-in recovery would replay the ORIGINAL consume and rewind to
    // the boot offset.
    expect(connection.last.consumes[0]).toEqual({
      queue: "raw.events-0",
      options: { noAck: false, arguments: { "x-stream-offset": { "!": "long", value: "21" } } },
    });
    await consumer.disconnect();
  });

  it("flushes the checkpoint on disconnect", async () => {
    const connection = new FakeConnection({
      ...testRabbitmqConfig,
      partitions: 1,
      checkpointEvery: 10_000,
      checkpointIntervalMs: 10_000,
    });
    const checkpoints = new InMemoryCheckpointStore();
    const consumer = createPolarisConsumer({
      connection: connection.asConnection(),
      groupName: "g",
      checkpoints,
    });
    await consumer.subscribe({ families: ["raw.events"] });
    await consumer.runEach(async () => undefined);

    connection.channels[0]?.deliver(streamDelivery({ offset: 33 }));
    await settle();
    // Not yet written: neither the count nor the interval threshold hit.
    expect(await checkpoints.read("g", "raw.events-0")).toBeUndefined();

    await consumer.disconnect();
    expect(await checkpoints.read("g", "raw.events-0")).toBe("33");
  });
});

describe("poison messages", () => {
  /** A producer double that records DLQ publishes. */
  function poisonProducer(): { producer: never; sent: Array<{ queue: string }> } {
    const sent: Array<{ queue: string }> = [];
    const producer = {
      async connect() {},
      async disconnect() {},
      async publishEvent() {
        throw new Error("not used");
      },
      async publish() {
        throw new Error("not used");
      },
      async publishToQueue(input: { queue: string }) {
        sent.push({ queue: input.queue });
      },
    } as unknown as never;
    return { producer, sent };
  }

  it("routes a message that keeps failing to the DLQ and advances past it", async () => {
    // Without this, one bad payload pins its partition forever and every
    // healthy event behind it waits with it.
    const connection = new FakeConnection({
      ...testRabbitmqConfig,
      partitions: 1,
      checkpointEvery: 1,
    });
    const checkpoints = new InMemoryCheckpointStore();
    const { producer, sent } = poisonProducer();
    const consumer = createPolarisConsumer({
      connection: connection.asConnection(),
      groupName: "g",
      checkpoints,
      retryDelayMs: 1,
      maxRetryDelayMs: 2,
      maxDeliveryAttempts: 3,
      poison: { component: "sessionizer", producer },
    });
    let calls = 0;
    await consumer.subscribe({ families: ["raw.events"] });
    await consumer.runEach(async () => {
      calls += 1;
      throw new Error("always fails");
    });

    // Re-deliver the same offset as the broker would after each rewind.
    for (let i = 0; i < 3; i += 1) {
      connection.last.deliver(streamDelivery({ offset: 9 }));
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(calls).toBeGreaterThanOrEqual(3);
    expect(sent).toEqual([{ queue: "sessionizer.dlq" }]);
    // Checkpoint advanced past the poison offset, so the partition drains.
    expect(await checkpoints.read("g", "raw.events-0")).toBe("9");
    await consumer.disconnect();
  });

  it("counts failures per offset, so an intermittent error never trips the limit", async () => {
    const connection = new FakeConnection({
      ...testRabbitmqConfig,
      partitions: 1,
      checkpointEvery: 1,
    });
    const { producer, sent } = poisonProducer();
    const consumer = createPolarisConsumer({
      connection: connection.asConnection(),
      groupName: "g",
      checkpoints: new InMemoryCheckpointStore(),
      retryDelayMs: 1,
      maxRetryDelayMs: 2,
      maxDeliveryAttempts: 2,
      poison: { component: "sessionizer", producer },
    });
    await consumer.subscribe({ families: ["raw.events"] });
    await consumer.runEach(async () => {
      throw new Error("transient");
    });

    // Different offsets each time: progress, not poison.
    for (let offset = 1; offset <= 3; offset += 1) {
      connection.last.deliver(streamDelivery({ offset }));
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(sent).toEqual([]);
    await consumer.disconnect();
  });

  it("keeps rewinding — loudly — when no DLQ is wired", async () => {
    const connection = new FakeConnection({ ...testRabbitmqConfig, partitions: 1 });
    const events: string[] = [];
    const consumer = createPolarisConsumer({
      connection: connection.asConnection(),
      groupName: "g",
      checkpoints: new InMemoryCheckpointStore(),
      retryDelayMs: 1,
      maxRetryDelayMs: 2,
      maxDeliveryAttempts: 2,
      hooks: {
        onEvent: (event) => {
          events.push(event);
        },
      },
    });
    await consumer.subscribe({ families: ["raw.events"] });
    await consumer.runEach(async () => {
      throw new Error("always fails");
    });

    for (let i = 0; i < 2; i += 1) {
      connection.last.deliver(streamDelivery({ offset: 4 }));
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    // Silently dropping the event would be worse than a visible stall, so
    // the consumer keeps trying — but it says so.
    expect(events).toContain("consumer.poisoned");
    await consumer.disconnect();
  });
});

describe("rewind discards in-flight deliveries", () => {
  it("does not process messages the broker pushed before the rewind", async () => {
    // Prefetch means the broker runs ahead of the handler. When a message
    // fails, the ones already queued behind it sit at HIGHER offsets —
    // handling them would advance the checkpoint past the failure and
    // silently skip the event the rewind exists to retry.
    const connection = new FakeConnection({
      ...testRabbitmqConfig,
      partitions: 1,
      checkpointEvery: 1,
    });
    const checkpoints = new InMemoryCheckpointStore();
    const consumer = createPolarisConsumer({
      connection: connection.asConnection(),
      groupName: "g",
      checkpoints,
      retryDelayMs: 5,
      maxRetryDelayMs: 10,
    });
    const handled: string[] = [];
    await consumer.subscribe({ families: ["raw.events"] });
    await consumer.runEach(async (payload) => {
      if (payload.message.offset === "5") throw new Error("fails");
      handled.push(payload.message.offset);
    });

    const channel = connection.channels[0];
    // Offset 5 fails; 6 and 7 were already in flight behind it.
    channel?.deliver(streamDelivery({ offset: 5 }));
    channel?.deliver(streamDelivery({ offset: 6 }));
    channel?.deliver(streamDelivery({ offset: 7 }));
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(handled).toEqual([]);
    // The checkpoint must not have jumped past the failed offset.
    const stored = await checkpoints.read("g", "raw.events-0");
    expect(stored === undefined || BigInt(stored) < 5n).toBe(true);
    await consumer.disconnect();
  });
});
