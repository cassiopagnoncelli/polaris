import { describe, expect, it } from "vitest";

import { buildRawEventsPartitionKey, resolveRawEventsPartitionKey } from "../src/partition-key.js";

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
