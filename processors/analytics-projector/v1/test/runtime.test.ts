/**
 * Streaming runtime tests for analytics-projector v1.
 *
 * The runtime is exercised through its `handler` slot — the same
 * `TransportMessageHandler` registered with the KafkaJS consumer. We
 * synthesise a minimal `TransportMessagePayload` and assert:
 *
 *   - happy path: producer.publishEvent is called with `family =
 *     analytics.events`, the canonical partition key, and the transformed
 *     envelope (processor metadata stamped on both nested and flat shapes).
 *   - empty/tombstone: handler logs and short-circuits, no publish.
 *   - bad JSON: handler throws so KafkaJS surfaces the failure.
 *   - missing envelope fields: handler throws.
 *
 * The producer slot is a recording stub — no RabbitMQ required. We do
 * not exercise `consumer.runEach` itself because that just forwards to
 * KafkaJS and is covered by `@polaris/shared-transport` tests.
 */

import {
  buildRawEventsPartitionKey,
  type PolarisConsumer,
  type TransportMessageContext,
  type PolarisProducer,
  type PublishEventInput,
  type SyncIsolationLookup,
  sharedOnlyIsolationLookup,
  STREAM_FAMILY_ANALYTICS_EVENTS,
  STREAM_FAMILY_RAW_EVENTS,
  type TransportMessagePayload,
} from "@polaris/shared-transport";
import { createLogger } from "@polaris/shared-logger";
import { describe, expect, it, vi } from "vitest";

import { createRuntime } from "../src/runtime.js";
import { PROCESSOR_NAME, PROCESSOR_VERSION } from "../src/transform.js";

const SAMPLE_ENVELOPE = {
  event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
  event: "payment.approved",
  schema_version: 1,
  project_id: "checkout",
  environment: "production",
  occurred_at: "2026-05-12T12:00:00.000Z",
  ingested_at: "2026-05-12T12:00:01.120Z",
  source: { type: "backend", id: "payments-api", sdk: "node", sdk_version: "1.0.0" },
  identity: { anonymous_id: null, session_id: null, customer_id: "cus_123", device_id: null },
  context: {
    ip: "203.0.113.10",
    user_agent: "Mozilla/5.0",
    locale: "en",
    page: null,
    campaign: null,
  },
  consent: { analytics: true, marketing: false, personalization: true },
  privacy: { classification: "internal" },
  properties: { payment_id: "pay_1" },
} as const;

const RAN_AT_ISO = "2026-05-12T12:00:02.000Z";

class RecordingProducer {
  public readonly publishes: Array<{
    family: string;
    event: Record<string, unknown>;
    partitionKey: string | undefined;
    isolation: SyncIsolationLookup;
  }> = [];
  public throwOnPublish: Error | undefined;
  public readonly raw: unknown = null;

  async connect(): Promise<void> {
    /* no-op */
  }

  async disconnect(): Promise<void> {
    /* no-op */
  }

  async publishEvent(input: PublishEventInput): Promise<unknown> {
    if (this.throwOnPublish !== undefined) {
      const err = this.throwOnPublish;
      this.throwOnPublish = undefined;
      throw err;
    }
    this.publishes.push({
      family: input.family,
      event: input.event as Record<string, unknown>,
      partitionKey: input.partitionKey,
      isolation: input.isolation,
    });
    return [];
  }

  async send(): Promise<unknown> {
    throw new Error("RecordingProducer.send not used in tests");
  }
}

/**
 * Stub consumer that satisfies the `PolarisConsumer` shape but never
 * actually subscribes to Kafka. The runtime's `start()` is not exercised
 * here — we drive `runtime.handler` directly.
 */
function stubConsumer(): PolarisConsumer {
  return {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    subscribe: vi.fn(async () => {}),
    runEach: vi.fn(async () => {}),
    run: vi.fn(async () => {}),
    raw: {} as PolarisConsumer["raw"],
  };
}

function buildPayload(value: Buffer | null): TransportMessagePayload {
  return {
    stream: `${STREAM_FAMILY_RAW_EVENTS}-0`,
    family: STREAM_FAMILY_RAW_EVENTS,
    partition: 0,
    message: {
      key: "partition-key",
      value,
      offset: "42",
      headers: {},
      timestamp: "0",
      redelivered: false,
    },
  };
}

const EMPTY_CONTEXT: TransportMessageContext = {};

function buildRuntime(producer: PolarisProducer) {
  const logger = createLogger({ service: "test", version: "0.0.0", env: "local" });
  return createRuntime({
    consumer: stubConsumer(),
    producer,
    logger,
    isolation: sharedOnlyIsolationLookup,
    now: () => new Date(RAN_AT_ISO),
  });
}

describe("createRuntime (analytics-projector v1)", () => {
  it("publishes a transformed event to analytics.events with the canonical partition key", async () => {
    const producer = new RecordingProducer();
    const runtime = buildRuntime(producer as unknown as PolarisProducer);

    const payload = buildPayload(Buffer.from(JSON.stringify(SAMPLE_ENVELOPE), "utf8"));
    await runtime.handler(payload, EMPTY_CONTEXT);

    expect(producer.publishes.length).toBe(1);
    const sent = producer.publishes[0];
    if (sent === undefined) throw new Error("expected one publish");
    expect(sent.family).toBe(STREAM_FAMILY_ANALYTICS_EVENTS);

    const expectedKey = buildRawEventsPartitionKey({
      project_id: SAMPLE_ENVELOPE.project_id,
      environment: SAMPLE_ENVELOPE.environment,
      event_id: SAMPLE_ENVELOPE.event_id,
      identity: SAMPLE_ENVELOPE.identity,
    });
    expect(sent.partitionKey).toBe(expectedKey);

    const emitted = sent.event;
    expect(emitted["event_id"]).toBe(SAMPLE_ENVELOPE.event_id);
    expect(emitted["processor"]).toEqual({
      name: PROCESSOR_NAME,
      version: PROCESSOR_VERSION,
      ran_at: RAN_AT_ISO,
    });
    expect(emitted["processor_name"]).toBe(PROCESSOR_NAME);
    expect(emitted["processor_version"]).toBe(PROCESSOR_VERSION);
    // Verbatim passthrough check on a couple of representative fields.
    expect(emitted["properties"]).toEqual(SAMPLE_ENVELOPE.properties);
    expect(emitted["identity"]).toEqual(SAMPLE_ENVELOPE.identity);
  });

  it("skips empty/tombstone messages without publishing", async () => {
    const producer = new RecordingProducer();
    const runtime = buildRuntime(producer as unknown as PolarisProducer);

    const payload = buildPayload(null);
    await runtime.handler(payload, EMPTY_CONTEXT);

    expect(producer.publishes.length).toBe(0);
  });

  it("throws when the payload is not valid JSON", async () => {
    const producer = new RecordingProducer();
    const runtime = buildRuntime(producer as unknown as PolarisProducer);

    const payload = buildPayload(Buffer.from("{not-json", "utf8"));
    await expect(runtime.handler(payload, EMPTY_CONTEXT)).rejects.toThrow();
    expect(producer.publishes.length).toBe(0);
  });

  it("throws when the decoded payload is missing required envelope fields", async () => {
    const producer = new RecordingProducer();
    const runtime = buildRuntime(producer as unknown as PolarisProducer);

    const bad = { event_id: "x", event: "y" };
    const payload = buildPayload(Buffer.from(JSON.stringify(bad), "utf8"));
    await expect(runtime.handler(payload, EMPTY_CONTEXT)).rejects.toThrow();
    expect(producer.publishes.length).toBe(0);
  });

  it("propagates producer errors so KafkaJS retries the message", async () => {
    const producer = new RecordingProducer();
    producer.throwOnPublish = new Error("broker down");
    const runtime = buildRuntime(producer as unknown as PolarisProducer);

    const payload = buildPayload(Buffer.from(JSON.stringify(SAMPLE_ENVELOPE), "utf8"));
    await expect(runtime.handler(payload, EMPTY_CONTEXT)).rejects.toThrow("broker down");
  });
});
