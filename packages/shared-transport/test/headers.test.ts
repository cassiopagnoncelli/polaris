import { describe, expect, it } from "vitest";

import {
  buildEventHeaders,
  fromAmqpHeaders,
  buildRetryHeaders,
  mergeHeaders,
  POLARIS_CONTENT_TYPE_JSON,
  POLARIS_HEADER_CONTENT_TYPE,
  POLARIS_HEADER_EVENT_ID,
  POLARIS_HEADER_PRODUCER,
  POLARIS_HEADER_RETRY_ATTEMPTS,
  POLARIS_HEADER_RETRY_REASON,
  POLARIS_HEADER_SCHEMA_VERSION,
  POLARIS_HEADER_SOURCE_PARTITION,
  POLARIS_HEADER_TOPIC_FAMILY,
  readHeaderNumber,
  readHeaderString,
  toAmqpHeaders,
} from "../src/headers.js";

describe("buildEventHeaders", () => {
  it("emits required platform headers", () => {
    const headers = buildEventHeaders({
      event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
      event_name: "checkout.started",
      schema_version: 1,
      project_id: "project-alpha",
      environment: "production",
      occurred_at: "2026-05-12T10:00:00.000Z",
      producer: "ingester-api",
      topic_family: "raw.events",
    });
    expect(headers[POLARIS_HEADER_EVENT_ID]).toBe("018f1b9e-7b50-7b12-9a2e-0e2f88d8f551");
    expect(headers[POLARIS_HEADER_SCHEMA_VERSION]).toBe("1");
    expect(headers[POLARIS_HEADER_TOPIC_FAMILY]).toBe("raw.events");
    expect(headers[POLARIS_HEADER_PRODUCER]).toBe("ingester-api");
    expect(headers[POLARIS_HEADER_CONTENT_TYPE]).toBe(POLARIS_CONTENT_TYPE_JSON);
  });

  it("omits optional fields when not provided", () => {
    const headers = buildEventHeaders({
      event_id: "id",
      event_name: "x.y",
      schema_version: 1,
      project_id: "p",
      environment: "test",
      occurred_at: "2026-05-12T10:00:00.000Z",
      producer: "ingester-api",
      topic_family: "raw.events",
    });
    // Optional headers must not appear as `undefined` entries.
    expect("polaris-ingested-at" in headers).toBe(false);
    expect("polaris-source-id" in headers).toBe(false);
    expect("polaris-producer-version" in headers).toBe(false);
  });
});

describe("buildRetryHeaders", () => {
  it("emits retry metadata headers", () => {
    const headers = buildRetryHeaders({
      attempts: 3,
      reason: "validation_failed",
      error_class: "ZodError",
      error_message: "invalid input",
      failed_at: "2026-05-12T10:30:00.000Z",
      source_topic: "raw.events",
      source_partition: 4,
      source_offset: "12345",
    });
    expect(headers[POLARIS_HEADER_RETRY_ATTEMPTS]).toBe("3");
    expect(headers[POLARIS_HEADER_RETRY_REASON]).toBe("validation_failed");
    expect(headers[POLARIS_HEADER_SOURCE_PARTITION]).toBe("4");
  });
});

describe("mergeHeaders", () => {
  it("later sources win on collision", () => {
    const merged = mergeHeaders({ a: "1", b: "2" }, { b: "3", c: "4" });
    expect(merged).toEqual({ a: "1", b: "3", c: "4" });
  });

  it("ignores undefined sources", () => {
    expect(mergeHeaders(undefined, { a: "1" })).toEqual({ a: "1" });
  });

  it("drops undefined values", () => {
    expect(mergeHeaders({ a: "1", b: undefined })).toEqual({ a: "1" });
  });
});

describe("readHeaderString / readHeaderNumber", () => {
  it("reads string headers verbatim", () => {
    expect(readHeaderString({ k: "value" }, "k")).toBe("value");
  });

  it("decodes Buffer headers as UTF-8", () => {
    expect(readHeaderString({ k: Buffer.from("hello", "utf8") }, "k")).toBe("hello");
  });

  it("returns undefined for missing or array-shaped headers", () => {
    expect(readHeaderString(undefined, "k")).toBeUndefined();
    expect(readHeaderString({}, "k")).toBeUndefined();
    expect(readHeaderString({ k: ["a", "b"] }, "k")).toBeUndefined();
  });

  it("parses numeric headers", () => {
    expect(readHeaderNumber({ n: "42" }, "n")).toBe(42);
  });

  it("returns undefined for unparsable numeric headers", () => {
    expect(readHeaderNumber({ n: "not-a-number" }, "n")).toBeUndefined();
    expect(readHeaderNumber(undefined, "n")).toBeUndefined();
  });
});

describe("toAmqpHeaders / fromAmqpHeaders", () => {
  it("normalizes everything to UTF-8 strings on the way out", () => {
    // AMQP field tables carry typed values; letting Buffers through would
    // mean the same header decodes as Buffer on one hop and string on the
    // next.
    expect(
      toAmqpHeaders({
        a: "plain",
        b: Buffer.from("buffered", "utf8"),
        c: ["x", Buffer.from("y", "utf8")],
        d: undefined,
      }),
    ).toEqual({ a: "plain", b: "buffered", c: "x,y" });
  });

  it("stringifies broker-supplied scalars on the way in", () => {
    expect(
      fromAmqpHeaders({
        "polaris-event-id": "e1",
        "x-stream-offset": 42,
        "x-retried": true,
        empty: null,
      }),
    ).toEqual({ "polaris-event-id": "e1", "x-stream-offset": "42", "x-retried": "true" });
  });

  it("JSON-encodes nested tables so x-death survives for DLQ triage", () => {
    const headers = fromAmqpHeaders({
      "x-death": [{ count: 3, reason: "expired", queue: "meta-capi.retry.5000" }],
    });
    expect(JSON.parse(String(headers["x-death"]))).toEqual([
      { count: 3, reason: "expired", queue: "meta-capi.retry.5000" },
    ]);
  });

  it("round-trips a Polaris header bag", () => {
    const original = buildEventHeaders({
      event_id: "e1",
      event_name: "page_viewed",
      schema_version: 1,
      project_id: "project-alpha",
      environment: "production",
      occurred_at: "2026-08-01T10:00:00.000Z",
      producer: "ingester-api",
      topic_family: "raw.events",
    });
    expect(fromAmqpHeaders(toAmqpHeaders(original))).toEqual(original);
  });

  it("tolerates missing header bags", () => {
    expect(toAmqpHeaders(undefined)).toEqual({});
    expect(fromAmqpHeaders(undefined)).toEqual({});
  });
});
