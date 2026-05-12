import { describe, expect, it } from "vitest";

import { EventDeserializationError, decodeEvent, encodeEvent } from "../src/serialization.js";

describe("encodeEvent / decodeEvent", () => {
  it("round-trips a canonical event envelope", () => {
    const envelope = {
      event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
      event: "checkout.started",
      schema_version: 1,
      project_id: "project-alpha",
      environment: "production",
      occurred_at: "2026-05-12T10:00:00.000Z",
      ingested_at: "2026-05-12T10:00:00.123Z",
      source: { type: "browser", id: "web-checkout" },
      identity: { customer_id: "cust-1", anonymous_id: null, session_id: null, device_id: null },
      context: { ip: null, user_agent: null, locale: null, page: null, campaign: null },
      properties: { total_cents: 4999, currency: "USD" },
    };
    const buf = encodeEvent(envelope);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(decodeEvent(buf)).toEqual(envelope);
  });

  it("decodes strings as well as Buffers", () => {
    const buf = encodeEvent({ a: 1 });
    expect(decodeEvent(buf.toString("utf8"))).toEqual({ a: 1 });
  });

  it("returns null for null / empty payloads (tombstones)", () => {
    expect(decodeEvent(null)).toBeNull();
    expect(decodeEvent(Buffer.alloc(0))).toBeNull();
    expect(decodeEvent("")).toBeNull();
  });

  it("throws EventDeserializationError on invalid JSON", () => {
    expect(() => decodeEvent(Buffer.from("{not-json", "utf8"))).toThrow(EventDeserializationError);
  });

  it("preserves the underlying error as cause", () => {
    try {
      decodeEvent(Buffer.from("{", "utf8"));
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EventDeserializationError);
      const error = err as EventDeserializationError;
      expect(error.cause).toBeInstanceOf(Error);
    }
  });
});
