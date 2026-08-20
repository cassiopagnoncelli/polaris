import { describe, expect, it } from "vitest";

import { readHeaderString } from "../src/headers.js";
import { partitionForKey } from "../src/partition-key.js";
import { createPolarisProducer } from "../src/producer.js";
import { sharedOnlyIsolationLookup, staticIsolationLookup } from "../src/stream-family.js";
import { STREAM_FAMILY_RAW_EVENTS } from "../src/streams.js";
import { FakeConnection, testRabbitmqConfig } from "./fakes.js";

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: "01920000-0000-7000-8000-000000000001",
    event: "page_viewed",
    schema_version: 1,
    project_id: "project-alpha",
    environment: "production",
    occurred_at: "2026-08-01T10:00:00.000Z",
    ingested_at: "2026-08-01T10:00:01.000Z",
    source: { id: "web-app" },
    identity: { customer_id: "cust-1" },
    context: {},
    properties: {},
    ...overrides,
  };
}

describe("createPolarisProducer.publishEvent", () => {
  it("routes to the super-stream exchange with the partition index as routing key", async () => {
    const connection = new FakeConnection();
    const producer = createPolarisProducer({
      connection: connection.asConnection(),
      producerName: "ingester-api",
    });
    await producer.connect();

    const result = await producer.publishEvent({
      family: STREAM_FAMILY_RAW_EVENTS,
      event: envelope() as never,
      isolation: sharedOnlyIsolationLookup,
    });

    const publish = connection.last.publishes[0];
    expect(publish?.exchange).toBe("raw.events");
    // The routing key IS the partition: RabbitMQ super streams put the
    // partitioning decision in the publisher's hands.
    expect(publish?.routingKey).toBe(String(result.partition));
    expect(result.stream).toBe(`raw.events-${result.partition}`);
  });

  it("hashes the canonical partition key so one identity always lands on one partition", async () => {
    const connection = new FakeConnection();
    const producer = createPolarisProducer({
      connection: connection.asConnection(),
      producerName: "ingester-api",
    });
    await producer.connect();

    const first = await producer.publishEvent({
      family: STREAM_FAMILY_RAW_EVENTS,
      event: envelope({ event_id: "e1" }) as never,
      isolation: sharedOnlyIsolationLookup,
    });
    const second = await producer.publishEvent({
      family: STREAM_FAMILY_RAW_EVENTS,
      event: envelope({ event_id: "e2" }) as never,
      isolation: sharedOnlyIsolationLookup,
    });

    expect(first.partition).toBe(second.partition);
    expect(first.partition).toBe(
      partitionForKey("project-alpha:production:cust-1", testRabbitmqConfig.partitions),
    );
  });

  it("publishes persistently, mandatory, with the partition key in messageId", async () => {
    const connection = new FakeConnection();
    const producer = createPolarisProducer({
      connection: connection.asConnection(),
      producerName: "ingester-api",
      producerVersion: "1.2.3",
    });
    await producer.connect();
    await producer.publishEvent({
      family: STREAM_FAMILY_RAW_EVENTS,
      event: envelope() as never,
      isolation: sharedOnlyIsolationLookup,
    });

    const options = connection.last.publishes[0]?.options ?? {};
    expect(options["persistent"]).toBe(true);
    // `mandatory` is the only way to notice a missing binding, which is
    // exactly what a half-provisioned topology looks like.
    expect(options["mandatory"]).toBe(true);
    expect(options["messageId"]).toBe("project-alpha:production:cust-1");

    const headers = options["headers"] as Record<string, string>;
    expect(headers["polaris-event-id"]).toBe("01920000-0000-7000-8000-000000000001");
    expect(headers["polaris-topic-family"]).toBe("raw.events");
    expect(headers["polaris-producer"]).toBe("ingester-api");
    expect(headers["polaris-producer-version"]).toBe("1.2.3");
  });

  it("routes an isolated project to its dedicated super stream", async () => {
    const connection = new FakeConnection();
    const producer = createPolarisProducer({
      connection: connection.asConnection(),
      producerName: "ingester-api",
    });
    await producer.connect();

    const result = await producer.publishEvent({
      family: STREAM_FAMILY_RAW_EVENTS,
      event: envelope() as never,
      isolation: staticIsolationLookup([
        { family: STREAM_FAMILY_RAW_EVENTS, project_id: "project-alpha" },
      ]),
    });

    expect(connection.last.publishes[0]?.exchange).toBe("raw.events.project-alpha");
    expect(result.stream.startsWith("raw.events.project-alpha-")).toBe(true);
  });

  it("merges extra headers over the platform bag", async () => {
    const connection = new FakeConnection();
    const producer = createPolarisProducer({
      connection: connection.asConnection(),
      producerName: "replay",
    });
    await producer.connect();
    await producer.publishEvent({
      family: STREAM_FAMILY_RAW_EVENTS,
      event: envelope() as never,
      isolation: sharedOnlyIsolationLookup,
      extraHeaders: { "polaris-replay-job-id": "job-1" },
    });

    const headers = connection.last.publishes[0]?.options["headers"] as Record<string, string>;
    expect(headers["polaris-replay-job-id"]).toBe("job-1");
  });

  it("fails the publish when the broker returns it as unroutable", async () => {
    const connection = new FakeConnection();
    const producer = createPolarisProducer({
      connection: connection.asConnection(),
      producerName: "ingester-api",
    });
    await producer.connect();
    connection.last.returnOnPublish = true;

    await expect(
      producer.publishEvent({
        family: STREAM_FAMILY_RAW_EVENTS,
        event: envelope() as never,
        isolation: sharedOnlyIsolationLookup,
      }),
    ).rejects.toThrow(/unroutable/);
  });

  it("propagates a broker nack on the confirm channel", async () => {
    const connection = new FakeConnection();
    const producer = createPolarisProducer({
      connection: connection.asConnection(),
      producerName: "ingester-api",
    });
    await producer.connect();
    connection.last.failPublishAt = 0;

    await expect(
      producer.publishEvent({
        family: STREAM_FAMILY_RAW_EVENTS,
        event: envelope() as never,
        isolation: sharedOnlyIsolationLookup,
      }),
    ).rejects.toThrow(/nacked by broker/);
  });

  it("opens a fresh channel after a reconnect", async () => {
    const connection = new FakeConnection();
    const producer = createPolarisProducer({
      connection: connection.asConnection(),
      producerName: "ingester-api",
    });
    await producer.connect();
    const before = connection.channels.length;

    await connection.fireReconnect();
    await producer.publishEvent({
      family: STREAM_FAMILY_RAW_EVENTS,
      event: envelope() as never,
      isolation: sharedOnlyIsolationLookup,
    });

    expect(connection.channels.length).toBe(before + 1);
  });
});

describe("createPolarisProducer.publishToQueue", () => {
  it("sends straight to the queue, bypassing stream routing", async () => {
    const connection = new FakeConnection();
    const producer = createPolarisProducer({
      connection: connection.asConnection(),
      producerName: "meta-capi",
    });
    await producer.connect();

    await producer.publishToQueue({
      queue: "meta-capi.retry.5000",
      value: Buffer.from("{}"),
      headers: { "polaris-retry-attempts": "1" },
      partitionKey: "project:env:cust",
    });

    const publish = connection.last.publishes[0];
    expect(publish?.exchange).toBe("");
    expect(publish?.routingKey).toBe("meta-capi.retry.5000");
    expect(publish?.options["messageId"]).toBe("project:env:cust");
    expect(readHeaderString(publish?.options["headers"] as never, "polaris-retry-attempts")).toBe(
      "1",
    );
  });
});

describe("unroutable returns under concurrent publishes", () => {
  it("blames the publish that was actually returned, not whichever confirm lands first", async () => {
    // The failure this guards: a shared "last return" slot. Publish A is
    // unroutable and publish B is fine; if the producer keys off a single
    // mutable slot, B inherits A's return (spurious 5xx) while A reports
    // success even though the broker dropped it — a silently lost event,
    // which is the worst outcome the ingester can produce.
    const connection = new FakeConnection();
    const producer = createPolarisProducer({
      connection: connection.asConnection(),
      producerName: "ingester-api",
    });
    await producer.connect();
    const channel = connection.last;
    channel.deferConfirms = true;

    const a = producer.publishEvent({
      family: STREAM_FAMILY_RAW_EVENTS,
      event: envelope({ event_id: "a", identity: { customer_id: "cust-a" } }) as never,
      isolation: sharedOnlyIsolationLookup,
    });
    const b = producer.publishEvent({
      family: STREAM_FAMILY_RAW_EVENTS,
      event: envelope({ event_id: "b", identity: { customer_id: "cust-b" } }) as never,
      isolation: sharedOnlyIsolationLookup,
    });

    // Let both publishes reach the channel before the broker responds.
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(channel.publishes).toHaveLength(2);

    // The broker returns A as unroutable, then confirms both — B first.
    channel.returnPublish(0);
    channel.releaseConfirm(1);
    channel.releaseConfirm(0);

    await expect(a).rejects.toThrow(/unroutable/);
    await expect(b).resolves.toBeDefined();
  });

  it("does not leak a stale return onto the next publish", async () => {
    const connection = new FakeConnection();
    const producer = createPolarisProducer({
      connection: connection.asConnection(),
      producerName: "ingester-api",
    });
    await producer.connect();
    const channel = connection.last;

    channel.returnAt.add(0);
    await expect(
      producer.publishEvent({
        family: STREAM_FAMILY_RAW_EVENTS,
        event: envelope({ event_id: "a" }) as never,
        isolation: sharedOnlyIsolationLookup,
      }),
    ).rejects.toThrow(/unroutable/);

    // The next publish is routable and must not inherit the failure.
    await expect(
      producer.publishEvent({
        family: STREAM_FAMILY_RAW_EVENTS,
        event: envelope({ event_id: "b" }) as never,
        isolation: sharedOnlyIsolationLookup,
      }),
    ).resolves.toBeDefined();
  });
});
