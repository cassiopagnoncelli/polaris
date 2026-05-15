import type { Kafka, Producer, ProducerRecord, RecordMetadata } from "kafkajs";
import { describe, expect, it, vi } from "vitest";
import {
  POLARIS_HEADER_EVENT_ID,
  POLARIS_HEADER_PRODUCER,
  POLARIS_HEADER_TOPIC_FAMILY,
} from "../src/headers.js";
import { createPolarisProducer } from "../src/producer.js";
import { sharedOnlyIsolationLookup, staticIsolationLookup } from "../src/topic-family.js";
import { TOPIC_FAMILY_RAW_EVENTS } from "../src/topics.js";

function fakeProducer(): { producer: Producer; sent: ProducerRecord[] } {
  const sent: ProducerRecord[] = [];
  const producer = {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    send: vi.fn(async (record: ProducerRecord): Promise<RecordMetadata[]> => {
      sent.push(record);
      return [];
    }),
    sendBatch: vi.fn(),
    transaction: vi.fn(),
    isIdempotent: vi.fn(() => false),
    events: {} as Producer["events"],
    on: vi.fn() as Producer["on"],
    logger: vi.fn() as Producer["logger"],
  } as unknown as Producer;
  return { producer, sent };
}

function fakeKafka(producer: Producer): Kafka {
  return {
    producer: vi.fn(() => producer),
    consumer: vi.fn(),
    admin: vi.fn(),
    logger: vi.fn(),
  } as unknown as Kafka;
}

const ENVELOPE = {
  event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
  event: "checkout.started",
  schema_version: 1,
  project_id: "project-alpha",
  environment: "production",
  occurred_at: "2026-05-12T10:00:00.000Z",
  ingested_at: "2026-05-12T10:00:00.123Z",
  source: { type: "browser" as const, id: "web-checkout" },
  identity: { customer_id: "cust-1", anonymous_id: null, session_id: null, device_id: null },
  context: { ip: null, user_agent: null, locale: null, page: null, campaign: null },
  properties: { total_cents: 4999, currency: "USD" },
};

describe("createPolarisProducer", () => {
  it("connects through the underlying KafkaJS producer", async () => {
    const { producer } = fakeProducer();
    const kafka = fakeKafka(producer);
    const wrapper = createPolarisProducer({ kafka, producerName: "ingester-api" });
    await wrapper.connect();
    expect(producer.connect).toHaveBeenCalledOnce();
    // Second call is idempotent.
    await wrapper.connect();
    expect(producer.connect).toHaveBeenCalledOnce();
  });

  it("publishes events to the shared topic when not isolated", async () => {
    const { producer, sent } = fakeProducer();
    const kafka = fakeKafka(producer);
    const wrapper = createPolarisProducer({ kafka, producerName: "ingester-api" });
    await wrapper.connect();
    await wrapper.publishEvent({
      family: TOPIC_FAMILY_RAW_EVENTS,
      event: ENVELOPE,
      isolation: sharedOnlyIsolationLookup,
    });
    expect(sent.length).toBe(1);
    const [record] = sent;
    expect(record).toBeDefined();
    if (record === undefined) return;
    expect(record.topic).toBe("raw.events");
    expect(record.messages.length).toBe(1);
    const [message] = record.messages;
    expect(message).toBeDefined();
    if (message === undefined) return;
    expect(message.key).toBe("project-alpha:production:cust-1");
    expect(message.headers?.[POLARIS_HEADER_EVENT_ID]).toBe(ENVELOPE.event_id);
    expect(message.headers?.[POLARIS_HEADER_TOPIC_FAMILY]).toBe("raw.events");
    expect(message.headers?.[POLARIS_HEADER_PRODUCER]).toBe("ingester-api");
  });

  it("routes to the dedicated topic when the project is isolated", async () => {
    const { producer, sent } = fakeProducer();
    const kafka = fakeKafka(producer);
    const wrapper = createPolarisProducer({ kafka, producerName: "ingester-api" });
    await wrapper.connect();
    await wrapper.publishEvent({
      family: TOPIC_FAMILY_RAW_EVENTS,
      event: ENVELOPE,
      isolation: staticIsolationLookup([
        { family: TOPIC_FAMILY_RAW_EVENTS, project_id: "project-alpha" },
      ]),
    });
    expect(sent[0]?.topic).toBe("raw.events.project-alpha");
  });

  it("invokes hooks on successful publish", async () => {
    const { producer } = fakeProducer();
    const kafka = fakeKafka(producer);
    const onEvent = vi.fn();
    const wrapper = createPolarisProducer({
      kafka,
      producerName: "ingester-api",
      hooks: { onEvent },
    });
    await wrapper.connect();
    await wrapper.publishEvent({
      family: TOPIC_FAMILY_RAW_EVENTS,
      event: ENVELOPE,
      isolation: sharedOnlyIsolationLookup,
    });
    const events = onEvent.mock.calls.map((call) => call[0] as string);
    expect(events).toContain("producer.connected");
    expect(events).toContain("producer.message_sent");
  });

  it("invokes the send_failed hook and re-throws on failure", async () => {
    const error = new Error("boom");
    const sent: ProducerRecord[] = [];
    const producer = {
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      send: vi.fn(async (record: ProducerRecord) => {
        sent.push(record);
        throw error;
      }),
      sendBatch: vi.fn(),
      transaction: vi.fn(),
      isIdempotent: vi.fn(() => false),
      events: {} as Producer["events"],
      on: vi.fn() as Producer["on"],
      logger: vi.fn() as Producer["logger"],
    } as unknown as Producer;
    const kafka = fakeKafka(producer);
    const onEvent = vi.fn();
    const wrapper = createPolarisProducer({
      kafka,
      producerName: "ingester-api",
      hooks: { onEvent },
    });
    await wrapper.connect();
    await expect(
      wrapper.publishEvent({
        family: TOPIC_FAMILY_RAW_EVENTS,
        event: ENVELOPE,
        isolation: sharedOnlyIsolationLookup,
      }),
    ).rejects.toBe(error);
    const events = onEvent.mock.calls.map((call) => call[0] as string);
    expect(events).toContain("producer.send_failed");
  });

  it("respects a caller-supplied partition key", async () => {
    const { producer, sent } = fakeProducer();
    const kafka = fakeKafka(producer);
    const wrapper = createPolarisProducer({ kafka, producerName: "ingester-api" });
    await wrapper.connect();
    await wrapper.publishEvent({
      family: TOPIC_FAMILY_RAW_EVENTS,
      event: ENVELOPE,
      isolation: sharedOnlyIsolationLookup,
      partitionKey: "explicit-key",
    });
    expect(sent[0]?.messages[0]?.key).toBe("explicit-key");
  });

  it("exposes the raw KafkaJS producer for advanced use", () => {
    const { producer } = fakeProducer();
    const kafka = fakeKafka(producer);
    const wrapper = createPolarisProducer({ kafka, producerName: "ingester-api" });
    expect(wrapper.raw).toBe(producer);
  });
});
