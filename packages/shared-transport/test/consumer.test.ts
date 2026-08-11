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
    await expect(
      consumer.subscribe({ families: ["raw.events"], partitions: [5] }),
    ).rejects.toThrow(/outside/);
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
    expect(connection.channels[0]?.nacked).toEqual([
      { message: expect.anything(), requeue: true },
    ]);
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
