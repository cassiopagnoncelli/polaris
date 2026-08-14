/**
 * Pure-decision tests for the identity-resolver v1 transform layer
 * (P8-002b).
 *
 * `resolveIdentityCandidate` inspects a canonical envelope and decides
 * whether the resolver has an *authoritative overlap* worth recording.
 * v1 considers `customer_id` and `anonymous_id` as strong identifiers
 * (`STRONG_IDENTITY_KINDS`); `session_id` and `device_id` are accepted
 * for forward compatibility but do not, by themselves, trigger a link.
 *
 * `orderPair` and `formatIdentifier` are the canonical-shape helpers
 * the runtime uses to keep emitted envelopes deterministic across
 * replays.
 *
 * @see docs/implementation/tasks/P8-002b-identity-resolver-behavioral-tests.md
 */

import { describe, expect, it } from "vitest";

import {
  type CompositeIdentifier,
  formatIdentifier,
  IDENTITY_KINDS,
  orderPair,
  PROCESSOR_IDENTITY,
  PROCESSOR_NAME,
  PROCESSOR_VERSION,
  resolveIdentityCandidate,
  STRONG_IDENTITY_KINDS,
} from "../src/transform.js";
import type { RawEventEnvelope } from "../src/types.js";

function envelope(identity: Partial<RawEventEnvelope["identity"]> = {}): RawEventEnvelope {
  return {
    event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
    event: "user.signed_in",
    schema_version: 1,
    project_id: "storefront",
    environment: "production",
    occurred_at: "2026-05-12T12:00:00.000Z",
    ingested_at: "2026-05-12T12:00:00.250Z",
    source: { type: "web", id: "storefront-web" },
    identity: {
      anonymous_id: null,
      session_id: null,
      customer_id: null,
      device_id: null,
      ...identity,
    },
    context: {},
    properties: {},
  };
}

describe("transform constants", () => {
  it("declares the canonical processor identity", () => {
    expect(PROCESSOR_NAME).toBe("identity-resolver");
    expect(PROCESSOR_VERSION).toBe("v1");
    expect(PROCESSOR_IDENTITY).toEqual({
      name: "identity-resolver",
      version: "v1",
    });
  });

  it("declares all four identity kinds in stable order", () => {
    expect(IDENTITY_KINDS).toEqual(["customer_id", "anonymous_id", "session_id", "device_id"]);
  });

  it("declares customer_id + anonymous_id as the strong identity set", () => {
    expect([...STRONG_IDENTITY_KINDS].sort()).toEqual(["anonymous_id", "customer_id"]);
  });
});

describe("formatIdentifier", () => {
  it("serialises (kind, value) into the canonical `kind:value` wire form", () => {
    expect(formatIdentifier("customer_id", "cus_123")).toBe("customer_id:cus_123");
    expect(formatIdentifier("anonymous_id", "anon-abc")).toBe("anonymous_id:anon-abc");
  });
});

describe("orderPair", () => {
  it("places the alphabetically-smaller kind on the left", () => {
    const customer: CompositeIdentifier = { kind: "customer_id", value: "cus_1" };
    const anonymous: CompositeIdentifier = { kind: "anonymous_id", value: "anon" };
    // 'anonymous_id' < 'customer_id' alphabetically.
    expect(orderPair(customer, anonymous)).toEqual({
      left: anonymous,
      right: customer,
    });
    // Symmetric: swap input order, same output.
    expect(orderPair(anonymous, customer)).toEqual({
      left: anonymous,
      right: customer,
    });
  });
});

describe("resolveIdentityCandidate", () => {
  it("returns { kind: 'none' } when no strong identifiers are present", () => {
    expect(resolveIdentityCandidate(envelope({ session_id: "sess-1" }))).toEqual({
      kind: "none",
    });
    expect(
      resolveIdentityCandidate(envelope({ session_id: "sess-1", device_id: "dev-1" })),
    ).toEqual({ kind: "none" });
  });

  it("returns 'none' when only one strong identifier is present", () => {
    expect(resolveIdentityCandidate(envelope({ customer_id: "cus_1" }))).toEqual({
      kind: "none",
    });
    expect(resolveIdentityCandidate(envelope({ anonymous_id: "anon" }))).toEqual({
      kind: "none",
    });
  });

  it("returns 'authoritative_overlap' with canonical ordering when both strong identifiers are present", () => {
    const result = resolveIdentityCandidate(
      envelope({ customer_id: "cus_1", anonymous_id: "anon" }),
    );
    expect(result.kind).toBe("authoritative_overlap");
    if (result.kind === "authoritative_overlap") {
      expect(result.left).toEqual({ kind: "anonymous_id", value: "anon" });
      expect(result.right).toEqual({ kind: "customer_id", value: "cus_1" });
    }
  });

  it("is deterministic: same input -> same canonical pair across calls", () => {
    const env = envelope({ customer_id: "cus_X", anonymous_id: "anon-X" });
    const a = resolveIdentityCandidate(env);
    const b = resolveIdentityCandidate(env);
    expect(a).toEqual(b);
  });

  it("ignores session_id and device_id even when both strong identifiers are also present", () => {
    // The presence of session/device should not change the chosen pair —
    // strong identifiers win.
    const result = resolveIdentityCandidate(
      envelope({
        customer_id: "cus_2",
        anonymous_id: "anon-2",
        session_id: "sess-noise",
        device_id: "device-noise",
      }),
    );
    expect(result.kind).toBe("authoritative_overlap");
    if (result.kind === "authoritative_overlap") {
      // session_id / device_id never become part of left/right in v1.
      expect(result.left.kind === "session_id" || result.left.kind === "device_id").toBe(false);
      expect(result.right.kind === "session_id" || result.right.kind === "device_id").toBe(false);
    }
  });

  it("treats empty-string identifier values as absent", () => {
    expect(resolveIdentityCandidate(envelope({ customer_id: "", anonymous_id: "anon" }))).toEqual({
      kind: "none",
    });
  });
});
