import { describe, expect, it } from "vitest";

import { readRetryAttempts, republishToDlq, republishToRetry } from "../src/dlq.js";
import type { PolarisProducer, PublishToQueueInput } from "../src/producer.js";

interface Recorded extends PublishToQueueInput {}

function fakeProducer(): { producer: PolarisProducer; sent: Recorded[] } {
  const sent: Recorded[] = [];
  const producer: PolarisProducer = {
    async connect() {},
    async disconnect() {},
    async publishEvent() {
      throw new Error("not used");
    },
    async publish() {
      throw new Error("not used");
    },
    async publishToQueue(input) {
      sent.push(input);
    },
  };
  return { producer, sent };
}

const base = {
  component: "meta-capi",
  value: Buffer.from('{"event_id":"e1"}'),
  key: "project:env:cust",
  sourceTopic: "analytics.events-1",
  sourcePartition: 1,
  sourceOffset: "42",
  reason: "vendor_5xx",
  errorClass: "HttpError",
  errorMessage: "502 Bad Gateway",
  failedAt: "2026-08-01T10:00:00.000Z",
};

describe("republishToRetry", () => {
  it("parks the message in the tier matching the attempt count", async () => {
    const { producer, sent } = fakeProducer();

    const tier = await republishToRetry(producer, base);

    expect(tier).toBe(5_000);
    expect(sent[0]?.queue).toBe("meta-capi.retry.5000");
  });

  it("climbs tiers as the attempt counter grows", async () => {
    const { producer, sent } = fakeProducer();

    await republishToRetry(producer, {
      ...base,
      headers: { "polaris-retry-attempts": "2" },
    });

    // attempts becomes 3 -> third tier
    expect(sent[0]?.queue).toBe("meta-capi.retry.120000");
    const headers = sent[0]?.headers ?? {};
    expect(headers["polaris-retry-attempts"]).toBe("3");
  });

  it("stamps the failure context and preserves the platform headers", async () => {
    const { producer, sent } = fakeProducer();

    await republishToRetry(producer, {
      ...base,
      headers: { "polaris-event-id": "e1", "polaris-project-id": "project-alpha" },
    });

    const headers = sent[0]?.headers ?? {};
    expect(headers["polaris-event-id"]).toBe("e1");
    expect(headers["polaris-project-id"]).toBe("project-alpha");
    expect(headers["polaris-retry-reason"]).toBe("vendor_5xx");
    expect(headers["polaris-error-class"]).toBe("HttpError");
    expect(headers["polaris-error-message"]).toBe("502 Bad Gateway");
    expect(headers["polaris-failed-at"]).toBe("2026-08-01T10:00:00.000Z");
    expect(headers["polaris-source-topic"]).toBe("analytics.events-1");
    expect(headers["polaris-source-partition"]).toBe("1");
    expect(headers["polaris-source-offset"]).toBe("42");
  });

  it("preserves the partition key so ordering survives the retry hop", async () => {
    const { producer, sent } = fakeProducer();
    await republishToRetry(producer, base);
    expect(sent[0]?.partitionKey).toBe("project:env:cust");
  });

  it("copies the original bytes verbatim", async () => {
    const { producer, sent } = fakeProducer();
    await republishToRetry(producer, base);
    // Replay tooling relies on event_id equality across hops, which only
    // holds if the payload is never re-serialized.
    expect(sent[0]?.value.toString("utf8")).toBe('{"event_id":"e1"}');
  });

  it("accepts a string body and a null body", async () => {
    const { producer, sent } = fakeProducer();
    await republishToRetry(producer, { ...base, value: '{"a":1}' });
    await republishToRetry(producer, { ...base, value: null });
    expect(sent[0]?.value.toString("utf8")).toBe('{"a":1}');
    expect(sent[1]?.value).toHaveLength(0);
  });

  it("honours an explicit attempt override", async () => {
    const { producer, sent } = fakeProducer();
    await republishToRetry(producer, { ...base, attempts: 5 });
    expect(sent[0]?.queue).toBe("meta-capi.retry.1800000");
  });
});

describe("republishToDlq", () => {
  it("sends to the component's terminal DLQ", async () => {
    const { producer, sent } = fakeProducer();
    await republishToDlq(producer, { ...base, headers: { "polaris-retry-attempts": "5" } });
    expect(sent[0]?.queue).toBe("meta-capi.dlq");
    expect(sent[0]?.headers?.["polaris-retry-attempts"]).toBe("6");
  });
});

describe("readRetryAttempts", () => {
  it("defaults to 0 and parses the header when present", () => {
    expect(readRetryAttempts(undefined)).toBe(0);
    expect(readRetryAttempts({})).toBe(0);
    expect(readRetryAttempts({ "polaris-retry-attempts": "3" })).toBe(3);
  });
});
