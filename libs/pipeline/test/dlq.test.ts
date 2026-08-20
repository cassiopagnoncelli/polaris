/**
 * Tests for `publishToDlq`.
 *
 * The helper wraps `@polaris/bus`'s `republishToDlq` with
 * processor-specific defaults (component name, failedAt timestamp,
 * classifier-derived reason). The tests use a stub `PolarisProducer` that
 * records `publishToQueue` calls so we can assert the resulting DLQ queue
 * name, headers, and message payload.
 */

import type {
  PolarisProducer,
  PublishToQueueInput,
  TransportMessagePayload,
} from "@polaris/bus";
import { describe, expect, it } from "vitest";

import { publishToDlq } from "../src/dlq.js";

function buildPayload(): TransportMessagePayload {
  return {
    stream: "raw.events-7",
    family: "raw.events",
    partition: 7,
    message: {
      key: "partition-key",
      value: Buffer.from(JSON.stringify({ event_id: "abc" }), "utf8"),
      offset: "42",
      headers: {
        "polaris-event-id": "abc",
        "polaris-project-id": "checkout",
      },
      timestamp: "0",
      redelivered: false,
    },
  };
}

class RecordingProducer {
  public sends: PublishToQueueInput[] = [];

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async publishEvent(): Promise<{ stream: string; partition: number }> {
    return { stream: "raw.events-0", partition: 0 };
  }
  async publish(): Promise<{ stream: string; partition: number }> {
    return { stream: "raw.events-0", partition: 0 };
  }
  async publishToQueue(input: PublishToQueueInput): Promise<void> {
    this.sends.push(input);
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
    expect(sent.queue).toBe("analytics-projector.dlq");
    expect(sent.value).toEqual(Buffer.from(JSON.stringify({ event_id: "abc" }), "utf8"));
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
    expect(sent.partitionKey).toBe("partition-key");
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
    const headers = (sent.headers ?? {}) as Record<string, unknown>;
    expect(headers["polaris-retry-reason"]).toBe("unknown_error");
    expect(headers["polaris-error-class"]).toBe("TypeError");
    expect(headers["polaris-error-message"]).toBe("invalid input");
    expect(headers["polaris-failed-at"]).toBe("2026-05-12T12:00:05.000Z");
    expect(headers["polaris-source-topic"]).toBe("raw.events-7");
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
    const headers = (sent.headers ?? {}) as Record<string, unknown>;
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
    const headers = (sent.headers ?? {}) as Record<string, unknown>;
    expect(headers["polaris-retry-reason"]).toBe("decode_failed");
  });
});
