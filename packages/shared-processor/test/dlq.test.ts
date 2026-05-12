/**
 * Tests for `publishToDlq`.
 *
 * The helper wraps `@polaris/shared-kafka`'s `republishToDlq` with
 * processor-specific defaults (component name, failedAt timestamp,
 * classifier-derived reason). The tests use a stub `PolarisProducer` that
 * records `send` calls so we can assert the resulting DLQ topic name,
 * headers, and message payload.
 */
import type { EachMessagePayload, ProducerRecord, RecordMetadata } from "kafkajs";
import { describe, expect, it } from "vitest";

import type { PolarisProducer } from "@polaris/shared-kafka";

import { publishToDlq } from "../src/dlq.js";

function buildPayload(): EachMessagePayload {
  return {
    topic: "raw.events",
    partition: 7,
    message: {
      key: Buffer.from("partition-key"),
      value: Buffer.from(JSON.stringify({ event_id: "abc" }), "utf8"),
      offset: "42",
      headers: {
        "polaris-event-id": "abc",
        "polaris-project-id": "checkout",
      },
      timestamp: "0",
      attributes: 0,
      size: 0,
    } as EachMessagePayload["message"],
    heartbeat: async () => {},
    pause: () => () => {},
  } as EachMessagePayload;
}

class RecordingProducer {
  public sends: Array<ProducerRecord> = [];
  public readonly raw: unknown = null;

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async publishEvent(): Promise<RecordMetadata[]> {
    return [];
  }
  async send(record: ProducerRecord): Promise<RecordMetadata[]> {
    this.sends.push(record);
    return [];
  }
}

describe("publishToDlq", () => {
  it("publishes to the component's `.dlq` topic with the original message bytes", async () => {
    const producer = new RecordingProducer();
    await publishToDlq({
      producer: producer as unknown as PolarisProducer,
      identity: { name: "analytics-projector", version: "v1" },
      payload: buildPayload(),
      error: new Error("broker unavailable"),
      failedAt: "2026-05-12T12:00:05.000Z",
    });
    expect(producer.sends.length).toBe(1);
    const sent = producer.sends[0];
    if (sent === undefined) throw new Error("expected one send");
    expect(sent.topic).toBe("analytics-projector.dlq");
    expect(sent.messages.length).toBe(1);
    const msg = sent.messages[0];
    if (msg === undefined) throw new Error("expected one message");
    expect(msg.value).toEqual(Buffer.from(JSON.stringify({ event_id: "abc" }), "utf8"));
  });

  it("preserves the original key for partition ordering", async () => {
    const producer = new RecordingProducer();
    await publishToDlq({
      producer: producer as unknown as PolarisProducer,
      identity: { name: "analytics-projector", version: "v1" },
      payload: buildPayload(),
      error: new Error("broker unavailable"),
    });
    const sent = producer.sends[0];
    if (sent === undefined) throw new Error("expected one send");
    const msg = sent.messages[0];
    if (msg === undefined) throw new Error("expected one message");
    expect(msg.key).toEqual(Buffer.from("partition-key"));
  });

  it("stamps retry/DLQ headers with the classified reason and the error class/message", async () => {
    const producer = new RecordingProducer();
    await publishToDlq({
      producer: producer as unknown as PolarisProducer,
      identity: { name: "analytics-projector", version: "v1" },
      payload: buildPayload(),
      error: new TypeError("invalid input"),
      failedAt: "2026-05-12T12:00:05.000Z",
    });
    const sent = producer.sends[0];
    if (sent === undefined) throw new Error("expected one send");
    const headers = (sent.messages[0]?.headers ?? {}) as Record<string, unknown>;
    expect(headers["polaris-retry-reason"]).toBe("unknown_error");
    expect(headers["polaris-error-class"]).toBe("TypeError");
    expect(headers["polaris-error-message"]).toBe("invalid input");
    expect(headers["polaris-failed-at"]).toBe("2026-05-12T12:00:05.000Z");
    expect(headers["polaris-source-topic"]).toBe("raw.events");
    expect(headers["polaris-source-partition"]).toBe("7");
    expect(headers["polaris-source-offset"]).toBe("42");
    // Original platform headers preserved.
    expect(headers["polaris-event-id"]).toBe("abc");
    expect(headers["polaris-project-id"]).toBe("checkout");
  });

  it("honours an explicit attempts override", async () => {
    const producer = new RecordingProducer();
    await publishToDlq({
      producer: producer as unknown as PolarisProducer,
      identity: { name: "analytics-projector", version: "v1" },
      payload: buildPayload(),
      error: new Error("third strike"),
      attempts: 5,
      failedAt: "2026-05-12T12:00:05.000Z",
    });
    const sent = producer.sends[0];
    if (sent === undefined) throw new Error("expected one send");
    const headers = (sent.messages[0]?.headers ?? {}) as Record<string, unknown>;
    expect(headers["polaris-retry-attempts"]).toBe("5");
  });

  it("respects a caller-supplied classification override", async () => {
    const producer = new RecordingProducer();
    await publishToDlq({
      producer: producer as unknown as PolarisProducer,
      identity: { name: "analytics-projector", version: "v1" },
      payload: buildPayload(),
      error: new Error("decoder bug"),
      classification: { retryable: false, reason: "decode_failed", description: "bad bytes" },
      failedAt: "2026-05-12T12:00:05.000Z",
    });
    const sent = producer.sends[0];
    if (sent === undefined) throw new Error("expected one send");
    const headers = (sent.messages[0]?.headers ?? {}) as Record<string, unknown>;
    expect(headers["polaris-retry-reason"]).toBe("decode_failed");
  });
});
