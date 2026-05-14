/**
 * Behavioral tests for the webhook-sink v1 mapper.
 *
 * The mapper is pure — no I/O, no clock, no PII reach. These tests pin:
 *
 *   - the wire payload shape is exactly the contract in `src/types.ts`
 *   - `delivery.consumer` carries the vendor + per-stage versions
 *   - the runtime-supplied `delivery_key` / `attempt` / `sent_at` slots
 *     are left as placeholders by the mapper and filled by `stampDelivery`
 *   - the mapper returns `{ kind: 'mapped', payload, dedupe_key }` and
 *     pins `dedupe_key` to the event_id (stable across attempts)
 *   - `stampDelivery` is pure and does NOT mutate its input
 *
 * @see consumers/webhook-sink/v1/src/mapper.ts
 * @see docs/architecture/06-destinations.md "Destination Consumer"
 */

import { describe, expect, it } from "vitest";

import type { MapperContext } from "@polaris/shared-destinations";

import { stampDelivery, webhookPassthroughMapper } from "../src/mapper.js";
import {
  CONSUMER_VENDOR,
  CONSUMER_VERSION,
  DELIVERER_VERSION,
  MAPPER_VERSION,
} from "../src/descriptor-identity.js";
import { fixtureMapperContext, fixtureNormalizedEvent } from "./fixtures/normalized.js";

describe("webhookPassthroughMapper", () => {
  it("returns { kind: 'mapped' } with version=1 and the normalized event under `event`", () => {
    const ctx = fixtureMapperContext();
    const result = webhookPassthroughMapper(ctx);

    expect(result.kind).toBe("mapped");
    if (result.kind !== "mapped") return;
    expect(result.payload.version).toBe(1);
    expect(result.payload.event).toBe(ctx.normalized);
  });

  it("stamps delivery.consumer with the pinned vendor + per-stage versions", () => {
    const ctx = fixtureMapperContext();
    const result = webhookPassthroughMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped result");

    expect(result.payload.delivery.consumer).toEqual({
      vendor: CONSUMER_VENDOR,
      consumer_version: CONSUMER_VERSION,
      mapper_version: MAPPER_VERSION,
      deliverer_version: DELIVERER_VERSION,
    });
  });

  it("leaves delivery_key/attempt/sent_at as runtime-overridable placeholders", () => {
    const ctx = fixtureMapperContext();
    const result = webhookPassthroughMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped result");

    // The mapper has no access to the runtime-assigned delivery key, the
    // attempt counter, or the per-attempt clock. The deliverer fills these.
    expect(result.payload.delivery.delivery_key).toBe("");
    expect(result.payload.delivery.attempt).toBe(0);
    expect(result.payload.delivery.sent_at).toBe("");
  });

  it("returns dedupe_key=event_id so receivers can short-circuit retries", () => {
    const ctx = fixtureMapperContext();
    const result = webhookPassthroughMapper(ctx);
    if (result.kind !== "mapped") throw new Error("expected mapped result");

    expect(result.dedupe_key).toBe(ctx.normalized.event_id);
  });

  it("is pure — does not mutate the normalized event", () => {
    const normalized = fixtureNormalizedEvent();
    // Deep-freeze the input would be ideal, but `Object.freeze` is shallow
    // and the structuredClone path is what we actually want to assert
    // against. Use JSON snapshots before/after.
    const before = JSON.stringify(normalized);
    webhookPassthroughMapper({ normalized, instance: fixtureMapperContext().instance });
    const after = JSON.stringify(normalized);
    expect(after).toBe(before);
  });

  it("works for any event name (passthrough — no per-event branching)", () => {
    const ctx1: MapperContext = {
      ...fixtureMapperContext(),
      normalized: { ...fixtureNormalizedEvent(), event: "user.identified" },
    };
    const ctx2: MapperContext = {
      ...fixtureMapperContext(),
      normalized: { ...fixtureNormalizedEvent(), event: "completely.unknown.event" },
    };
    const r1 = webhookPassthroughMapper(ctx1);
    const r2 = webhookPassthroughMapper(ctx2);
    expect(r1.kind).toBe("mapped");
    expect(r2.kind).toBe("mapped");
  });
});

describe("stampDelivery", () => {
  it("overwrites delivery_key / attempt / sent_at and returns a new object", () => {
    const ctx = fixtureMapperContext();
    const mapped = webhookPassthroughMapper(ctx);
    if (mapped.kind !== "mapped") throw new Error("expected mapped result");

    const stamped = stampDelivery(mapped.payload, {
      delivery_key: "pdk_test_abc123",
      attempt: 3,
      sent_at: "2026-05-14T12:34:56.789Z",
    });

    expect(stamped.delivery.delivery_key).toBe("pdk_test_abc123");
    expect(stamped.delivery.attempt).toBe(3);
    expect(stamped.delivery.sent_at).toBe("2026-05-14T12:34:56.789Z");
    // Returns a new object — the input is untouched.
    expect(stamped).not.toBe(mapped.payload);
    expect(mapped.payload.delivery.delivery_key).toBe("");
    expect(mapped.payload.delivery.attempt).toBe(0);
    expect(mapped.payload.delivery.sent_at).toBe("");
  });

  it("preserves the consumer block and the event reference", () => {
    const ctx = fixtureMapperContext();
    const mapped = webhookPassthroughMapper(ctx);
    if (mapped.kind !== "mapped") throw new Error("expected mapped result");

    const stamped = stampDelivery(mapped.payload, {
      delivery_key: "x",
      attempt: 1,
      sent_at: "2026-05-14T00:00:00.000Z",
    });

    expect(stamped.delivery.consumer).toEqual(mapped.payload.delivery.consumer);
    expect(stamped.event).toBe(mapped.payload.event);
    expect(stamped.version).toBe(1);
  });
});
