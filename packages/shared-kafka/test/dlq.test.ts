import type { Kafka, Producer, ProducerRecord, RecordMetadata } from "kafkajs";
import { describe, expect, it, vi } from "vitest";
import { readRetryAttempts, republishToDlq, republishToRetry } from "../src/dlq.js";
import {
  POLARIS_HEADER_ERROR_CLASS,
  POLARIS_HEADER_FAILED_AT,
  POLARIS_HEADER_RETRY_ATTEMPTS,
  POLARIS_HEADER_RETRY_REASON,
  POLARIS_HEADER_SOURCE_OFFSET,
  POLARIS_HEADER_SOURCE_TOPIC,
} from "../src/headers.js";
import { createPolarisProducer } from "../src/producer.js";

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

describe("readRetryAttempts", () => {
  it("defaults to 0 when the header is missing", () => {
    expect(readRetryAttempts(undefined)).toBe(0);
    expect(readRetryAttempts({})).toBe(0);
  });

  it("parses the polaris-retry-attempts header", () => {
    expect(readRetryAttempts({ [POLARIS_HEADER_RETRY_ATTEMPTS]: "3" })).toBe(3);
  });
});

describe("republishToRetry", () => {
  it("writes to <component>.retry with bumped attempts and failure context", async () => {
    const { producer, sent } = fakeProducer();
    const kafka = fakeKafka(producer);
    const wrapper = createPolarisProducer({ kafka, producerName: "test" });
    await wrapper.connect();
    await republishToRetry(wrapper, {
      component: "geoip-enricher",
      value: Buffer.from("event-bytes", "utf8"),
      key: "project-x:production:cust-1",
      headers: { existing: "h", [POLARIS_HEADER_RETRY_ATTEMPTS]: "1" },
      sourceTopic: "raw.events",
      sourcePartition: 4,
      sourceOffset: "12345",
      reason: "geoip_lookup_failed",
      errorClass: "TimeoutError",
      errorMessage: "lookup deadline exceeded",
      failedAt: "2026-05-12T10:30:00.000Z",
    });
    expect(sent.length).toBe(1);
    const record = sent[0];
    expect(record).toBeDefined();
    if (record === undefined) return;
    expect(record.topic).toBe("geoip-enricher.retry");
    const message = record.messages[0];
    expect(message).toBeDefined();
    if (message === undefined) return;
    expect(message.key).toBe("project-x:production:cust-1");
    // Attempts bumped from 1 -> 2.
    expect(message.headers?.[POLARIS_HEADER_RETRY_ATTEMPTS]).toBe("2");
    expect(message.headers?.[POLARIS_HEADER_RETRY_REASON]).toBe("geoip_lookup_failed");
    expect(message.headers?.[POLARIS_HEADER_ERROR_CLASS]).toBe("TimeoutError");
    expect(message.headers?.[POLARIS_HEADER_FAILED_AT]).toBe("2026-05-12T10:30:00.000Z");
    expect(message.headers?.[POLARIS_HEADER_SOURCE_TOPIC]).toBe("raw.events");
    expect(message.headers?.[POLARIS_HEADER_SOURCE_OFFSET]).toBe("12345");
    // Pre-existing custom headers survive.
    expect(message.headers?.existing).toBe("h");
  });

  it("defaults attempts to 1 when no prior attempt header is present", async () => {
    const { producer, sent } = fakeProducer();
    const kafka = fakeKafka(producer);
    const wrapper = createPolarisProducer({ kafka, producerName: "test" });
    await wrapper.connect();
    await republishToRetry(wrapper, {
      component: "meta-capi",
      value: null,
      sourceTopic: "analytics.events",
      reason: "vendor_5xx",
      failedAt: "2026-05-12T10:30:00.000Z",
    });
    const record = sent[0];
    expect(record).toBeDefined();
    if (record === undefined) return;
    const message = record.messages[0];
    expect(message?.headers?.[POLARIS_HEADER_RETRY_ATTEMPTS]).toBe("1");
  });
});

describe("republishToDlq", () => {
  it("writes to <component>.dlq", async () => {
    const { producer, sent } = fakeProducer();
    const kafka = fakeKafka(producer);
    const wrapper = createPolarisProducer({ kafka, producerName: "test" });
    await wrapper.connect();
    await republishToDlq(wrapper, {
      component: "identity-resolver",
      value: Buffer.from("event-bytes", "utf8"),
      sourceTopic: "raw.events",
      reason: "unrecoverable",
      failedAt: "2026-05-12T10:30:00.000Z",
    });
    expect(sent[0]?.topic).toBe("identity-resolver.dlq");
  });

  it("respects an explicit attempts override", async () => {
    const { producer, sent } = fakeProducer();
    const kafka = fakeKafka(producer);
    const wrapper = createPolarisProducer({ kafka, producerName: "test" });
    await wrapper.connect();
    await republishToDlq(wrapper, {
      component: "ga4",
      value: null,
      sourceTopic: "analytics.events",
      reason: "test",
      failedAt: "2026-05-12T10:30:00.000Z",
      attempts: 7,
    });
    expect(sent[0]?.messages[0]?.headers?.[POLARIS_HEADER_RETRY_ATTEMPTS]).toBe("7");
  });
});
