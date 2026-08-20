/**
 * Tests for `classifyError`.
 *
 * The classifier returns a small structured verdict per error. The tests
 * pin the verdict per representative error category so processors and
 * their tests can trust the routing without re-deriving the rules.
 */
import { describe, expect, it } from "vitest";

import { classifyError } from "../src/classify.js";

describe("classifyError", () => {
  it("classifies null and undefined as unknown_error, non-retryable", () => {
    expect(classifyError(null)).toMatchObject({ retryable: false, reason: "unknown_error" });
    expect(classifyError(undefined)).toMatchObject({
      retryable: false,
      reason: "unknown_error",
    });
  });

  it("classifies string errors as unknown_error, non-retryable", () => {
    const v = classifyError("something went wrong");
    expect(v.retryable).toBe(false);
    expect(v.reason).toBe("unknown_error");
    expect(v.description).toContain("something went wrong");
  });

  it("classifies decode failures as decode_failed, non-retryable", () => {
    class EventDeserializationError extends Error {
      public override readonly name = "EventDeserializationError";
    }
    const err = new EventDeserializationError("Failed to parse Polaris event payload as JSON: bad");
    const v = classifyError(err);
    expect(v.retryable).toBe(false);
    expect(v.reason).toBe("decode_failed");
  });

  it("classifies Zod errors as invalid_properties, non-retryable", () => {
    class ZodError extends Error {
      public override readonly name = "ZodError";
    }
    const v = classifyError(new ZodError("validation failed"));
    expect(v.retryable).toBe(false);
    expect(v.reason).toBe("invalid_properties");
  });

  it("classifies envelope failures as invalid_envelope, non-retryable", () => {
    const v = classifyError(new Error("raw.events payload missing required envelope fields"));
    expect(v.retryable).toBe(false);
    expect(v.reason).toBe("invalid_envelope");
  });

  it("classifies unsupported schema versions as unsupported_schema_version, non-retryable", () => {
    const v = classifyError(new Error("unsupported schema version v999"));
    expect(v.retryable).toBe(false);
    expect(v.reason).toBe("unsupported_schema_version");
  });

  it("classifies schema sunset as schema_version_sunset, non-retryable", () => {
    const v = classifyError(new Error("schema is past its sunset_at"));
    expect(v.retryable).toBe(false);
    expect(v.reason).toBe("schema_version_sunset");
  });

  it("classifies retriable KafkaJS errors as transient_failure, retryable", () => {
    class KafkaJSConnectionError extends Error {
      public override readonly name = "KafkaJSConnectionError";
      public readonly retriable = true;
    }
    const v = classifyError(new KafkaJSConnectionError("broker reset"));
    expect(v.retryable).toBe(true);
    expect(v.reason).toBe("transient_failure");
  });

  it("classifies non-retriable KafkaJS errors as publish_failed, non-retryable", () => {
    class KafkaJSProtocolError extends Error {
      public override readonly name = "KafkaJSProtocolError";
      public readonly retriable = false;
    }
    const v = classifyError(new KafkaJSProtocolError("invalid topic"));
    expect(v.retryable).toBe(false);
    expect(v.reason).toBe("publish_failed");
  });

  it("classifies common Node network errno codes as network_error, retryable", () => {
    for (const code of ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH"]) {
      const err: Error & { code?: string } = new Error(`socket ${code}`);
      err.code = code;
      const v = classifyError(err);
      expect(v.retryable, `${code} should be retryable`).toBe(true);
      expect(v.reason).toBe("network_error");
    }
  });

  it("classifies FetchError as network_error, retryable", () => {
    class FetchError extends Error {
      public override readonly name = "FetchError";
    }
    const v = classifyError(new FetchError("upstream unreachable"));
    expect(v.retryable).toBe(true);
    expect(v.reason).toBe("network_error");
  });

  it("falls back to unknown_error, retryable, for generic Error", () => {
    const v = classifyError(new Error("something transient"));
    expect(v.retryable).toBe(true);
    expect(v.reason).toBe("unknown_error");
  });

  it("truncates long descriptions to a stable size", () => {
    const long = "x".repeat(1024);
    const v = classifyError(new Error(long));
    expect(v.description.length).toBeLessThanOrEqual(512);
  });
});
