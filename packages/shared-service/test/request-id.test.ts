import { describe, expect, it } from "vitest";

import {
  newRequestId,
  normalizeIncomingRequestId,
  POLARIS_REQUEST_ID_HEADER,
  REQUEST_ID_HEADER,
  resolveRequestId,
} from "../src/index.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_V7_VERSION_NIBBLE_INDEX = 14;

describe("newRequestId", () => {
  it("emits a UUIDv7 string", () => {
    const id = newRequestId();
    expect(id).toMatch(UUID_REGEX);
    // UUID version nibble (char 14 in the canonical form) must be `7`.
    expect(id[UUID_V7_VERSION_NIBBLE_INDEX]).toBe("7");
  });

  it("is time-ordered: sequential IDs sort the same as their generation order", () => {
    const ids = Array.from({ length: 20 }, () => newRequestId());
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });
});

describe("normalizeIncomingRequestId", () => {
  it("accepts canonical UUID shapes (any version)", () => {
    // v4
    expect(normalizeIncomingRequestId("018f1b9e-7b50-4b12-9a2e-0e2f88d8f551")).toBe(
      "018f1b9e-7b50-4b12-9a2e-0e2f88d8f551",
    );
    // v7
    expect(normalizeIncomingRequestId("018f1b9e-7b50-7b12-9a2e-0e2f88d8f551")).toBe(
      "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
    );
  });

  it("lowercases the returned value", () => {
    expect(normalizeIncomingRequestId("018F1B9E-7B50-7B12-9A2E-0E2F88D8F551")).toBe(
      "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeIncomingRequestId("  018f1b9e-7b50-7b12-9a2e-0e2f88d8f551  ")).toBe(
      "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
    );
  });

  it("rejects malformed input", () => {
    expect(normalizeIncomingRequestId("not-a-uuid")).toBeUndefined();
    expect(normalizeIncomingRequestId("")).toBeUndefined();
    expect(normalizeIncomingRequestId(null)).toBeUndefined();
    expect(normalizeIncomingRequestId(undefined)).toBeUndefined();
    expect(normalizeIncomingRequestId(12345)).toBeUndefined();
    // Too short
    expect(normalizeIncomingRequestId("018f1b9e-7b50-7b12-9a2e")).toBeUndefined();
    // Bad characters
    expect(normalizeIncomingRequestId("018f1b9e-7b50-7b12-9a2e-0e2f88d8XXXX")).toBeUndefined();
  });
});

describe("resolveRequestId", () => {
  it("prefers the Polaris-branded header over the standard one", () => {
    const id = resolveRequestId({
      [POLARIS_REQUEST_ID_HEADER]: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
      [REQUEST_ID_HEADER]: "018f1b9e-7b50-7b12-9a2e-0e2f88d8aaaa",
    });
    expect(id).toBe("018f1b9e-7b50-7b12-9a2e-0e2f88d8f551");
  });

  it("falls back to the generic header when the Polaris header is missing", () => {
    const id = resolveRequestId({
      [REQUEST_ID_HEADER]: "018f1b9e-7b50-7b12-9a2e-0e2f88d8aaaa",
    });
    expect(id).toBe("018f1b9e-7b50-7b12-9a2e-0e2f88d8aaaa");
  });

  it("generates a fresh UUIDv7 when neither header is set", () => {
    const id = resolveRequestId({});
    expect(id).toMatch(UUID_REGEX);
    expect(id[UUID_V7_VERSION_NIBBLE_INDEX]).toBe("7");
  });

  it("ignores invalid header values and generates a fresh ID", () => {
    const id = resolveRequestId({
      [POLARIS_REQUEST_ID_HEADER]: "not-a-uuid",
      [REQUEST_ID_HEADER]: "garbage",
    });
    expect(id).toMatch(UUID_REGEX);
  });
});
