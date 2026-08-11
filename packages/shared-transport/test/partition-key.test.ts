import { describe, expect, it } from "vitest";

import {
  buildRawEventsPartitionKey,
  partitionForKey,
  resolveRawEventsPartitionKey,
} from "../src/partition-key.js";

const ENV = "production";
const PROJECT = "project-alpha";
const EVENT_ID = "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551";

describe("buildRawEventsPartitionKey", () => {
  it("uses customer_id when present (highest priority)", () => {
    const key = buildRawEventsPartitionKey({
      project_id: PROJECT,
      environment: ENV,
      event_id: EVENT_ID,
      identity: {
        customer_id: "cust-1",
        anonymous_id: "anon-1",
        session_id: "sess-1",
      },
    });
    expect(key).toBe(`${PROJECT}:${ENV}:cust-1`);
  });

  it("falls back to anonymous_id when customer_id is missing", () => {
    const key = buildRawEventsPartitionKey({
      project_id: PROJECT,
      environment: ENV,
      event_id: EVENT_ID,
      identity: {
        anonymous_id: "anon-1",
        session_id: "sess-1",
      },
    });
    expect(key).toBe(`${PROJECT}:${ENV}:anon-1`);
  });

  it("falls back to session_id when customer_id and anonymous_id are missing", () => {
    const key = buildRawEventsPartitionKey({
      project_id: PROJECT,
      environment: ENV,
      event_id: EVENT_ID,
      identity: {
        session_id: "sess-1",
      },
    });
    expect(key).toBe(`${PROJECT}:${ENV}:sess-1`);
  });

  it("falls back to event_id when no identity is available", () => {
    const key = buildRawEventsPartitionKey({
      project_id: PROJECT,
      environment: ENV,
      event_id: EVENT_ID,
      identity: {},
    });
    expect(key).toBe(`${PROJECT}:${ENV}:${EVENT_ID}`);
  });

  it("treats null identity fields as missing", () => {
    const key = buildRawEventsPartitionKey({
      project_id: PROJECT,
      environment: ENV,
      event_id: EVENT_ID,
      identity: {
        customer_id: null,
        anonymous_id: null,
        session_id: "sess-1",
      },
    });
    expect(key).toBe(`${PROJECT}:${ENV}:sess-1`);
  });

  it("treats empty-string identity fields as missing", () => {
    const key = buildRawEventsPartitionKey({
      project_id: PROJECT,
      environment: ENV,
      event_id: EVENT_ID,
      identity: {
        customer_id: "",
        anonymous_id: "anon-1",
      },
    });
    expect(key).toBe(`${PROJECT}:${ENV}:anon-1`);
  });

  it("rejects empty project_id", () => {
    expect(() =>
      buildRawEventsPartitionKey({
        project_id: "",
        environment: ENV,
        event_id: EVENT_ID,
        identity: { customer_id: "cust-1" },
      }),
    ).toThrow(RangeError);
  });

  it("rejects empty environment", () => {
    expect(() =>
      buildRawEventsPartitionKey({
        project_id: PROJECT,
        environment: "",
        event_id: EVENT_ID,
        identity: { customer_id: "cust-1" },
      }),
    ).toThrow(RangeError);
  });

  it("rejects empty event_id even when other identity is present (event_id is the final fallback and is always required)", () => {
    expect(() =>
      buildRawEventsPartitionKey({
        project_id: PROJECT,
        environment: ENV,
        event_id: "",
        identity: { customer_id: "cust-1" },
      }),
    ).toThrow(RangeError);
  });
});

describe("resolveRawEventsPartitionKey", () => {
  it("reports which identity source was used", () => {
    expect(
      resolveRawEventsPartitionKey({
        project_id: PROJECT,
        environment: ENV,
        event_id: EVENT_ID,
        identity: { customer_id: "cust-1", anonymous_id: "anon-1" },
      }).source,
    ).toBe("customer_id");

    expect(
      resolveRawEventsPartitionKey({
        project_id: PROJECT,
        environment: ENV,
        event_id: EVENT_ID,
        identity: { anonymous_id: "anon-1" },
      }).source,
    ).toBe("anonymous_id");

    expect(
      resolveRawEventsPartitionKey({
        project_id: PROJECT,
        environment: ENV,
        event_id: EVENT_ID,
        identity: { session_id: "sess-1" },
      }).source,
    ).toBe("session_id");

    expect(
      resolveRawEventsPartitionKey({
        project_id: PROJECT,
        environment: ENV,
        event_id: EVENT_ID,
        identity: {},
      }).source,
    ).toBe("event_id");
  });

  it("returns the resolved identity value alongside the key", () => {
    const result = resolveRawEventsPartitionKey({
      project_id: PROJECT,
      environment: ENV,
      event_id: EVENT_ID,
      identity: { customer_id: "cust-1" },
    });
    expect(result.identity).toBe("cust-1");
    expect(result.key).toBe(`${PROJECT}:${ENV}:cust-1`);
  });
});

describe("partitionForKey", () => {
  it("is stable for the same key and width", () => {
    // This mapping is a wire contract: changing it breaks per-identity
    // ordering across a rolling deploy, exactly like swapping a Kafka
    // partitioner would.
    const first = partitionForKey("project-alpha:production:cust-1", 6);
    const second = partitionForKey("project-alpha:production:cust-1", 6);
    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(6);
  });

  it("stays inside the partition range for any key", () => {
    for (let i = 0; i < 500; i += 1) {
      const partition = partitionForKey(`project:env:identity-${String(i)}`, 3);
      expect(partition).toBeGreaterThanOrEqual(0);
      expect(partition).toBeLessThan(3);
    }
  });

  it("spreads keys across partitions", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i += 1) {
      seen.add(partitionForKey(`project:env:identity-${String(i)}`, 6));
    }
    // FNV-1a over these shapes should touch every partition well before
    // 200 keys; a hash that collapsed would show up here as hot-partition
    // skew in production.
    expect(seen.size).toBe(6);
  });

  it("sends keyless messages to partition 0 rather than throwing", () => {
    expect(partitionForKey(null, 4)).toBe(0);
    expect(partitionForKey(undefined, 4)).toBe(0);
    expect(partitionForKey("", 4)).toBe(0);
  });

  it("collapses to partition 0 for a single-partition family", () => {
    expect(partitionForKey("anything", 1)).toBe(0);
  });

  it("rejects a non-positive partition count", () => {
    expect(() => partitionForKey("k", 0)).toThrow(RangeError);
    expect(() => partitionForKey("k", 1.5)).toThrow(RangeError);
  });
});
