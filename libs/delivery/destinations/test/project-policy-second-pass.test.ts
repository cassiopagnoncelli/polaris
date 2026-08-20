/**
 * The delivery-side half of H0GI1EZ0.
 *
 * `normalizeForDestination` has accepted a `projectPolicyOverride` since
 * it was written, and the runtime never passed one — so the second-pass
 * redaction ran on platform defaults for every project while the
 * ingester's first pass (once wired) ran the project's override. The two
 * enforcement points disagreeing is worse than either being wrong on its
 * own: an operator reads the override file and cannot tell which pass
 * honours it.
 *
 * These tests drive `handleEvent` and assert on what the MAPPER receives,
 * because that is the last thing between the runtime and a vendor.
 *
 * The override here is a local fixture, not the real `definitions/policy`
 * registry: this package deliberately does not depend on the catalog (the
 * host injects it), so the test proves the *plumbing* carries whatever
 * override it is handed.
 */

import type { NormalizableEnvelope } from "@polaris/delivery-normalize";
import type { Logger } from "@polaris/observability-logger";
import { POLICY_REASON_POLICY, type ProjectPolicyOverride } from "@polaris/governance";
import { describe, expect, it } from "vitest";

import {
  createDestinationConsumer,
  type Deliverer,
  type DestinationDescriptor,
  type DestinationInstance,
  InMemoryDeliveryRecordRepository,
  InMemoryDestinationDedupe,
  InMemoryDestinationInstanceReader,
  type Mapper,
} from "../src/index.js";

const noopLogger: Logger = {
  fatal: () => {},
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => noopLogger,
} as unknown as Logger;

const RAW_EMAIL = "shopper@example.com";

const INSTANCE: DestinationInstance = {
  destination_id: "polaris_dst_policy1",
  project_id: "checkout",
  environment: "development",
  vendor: "test-vendor",
  instance_label: "policy-test",
  secret_value: "<test-secret>",
  status: "active",
  mode: "live",
  max_concurrency: 4,
  max_rps: 50,
  retry_policy: "standard",
  dead_letter_threshold: 5,
  replay_opt_in: true,
  config: {},
};

/**
 * Adds a redaction the platform defaults do not have. A raw email is
 * deliberately one of the categories the platform policy documents as
 * intentionally absent, so any redaction observed here can only have come
 * from this override.
 */
const CHECKOUT_LIKE_OVERRIDE: ProjectPolicyOverride = {
  project_id: "checkout",
  redactNamed: [
    {
      field: "properties.email",
      reason: POLICY_REASON_POLICY,
      note: "raw email must not reach a vendor in the clear",
    },
  ],
};

function makeEnvelope(overrides: Partial<NormalizableEnvelope> = {}): NormalizableEnvelope {
  return {
    event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
    event: "payment.approved",
    schema_version: 1,
    project_id: "checkout",
    environment: "development",
    occurred_at: "2026-05-12T11:30:00.000Z",
    ingested_at: "2026-05-12T11:30:00.250Z",
    source: { id: "checkout-api", type: "backend" },
    identity: {
      anonymous_id: "anon-abc",
      session_id: "sess-xyz",
      customer_id: "cust-123",
      device_id: null,
    },
    context: null,
    properties: { amount: 4200, currency: "USD", email: RAW_EMAIL },
    consent: { marketing: true, analytics: true },
    ...overrides,
  };
}

/**
 * Run one envelope through the runtime and hand back the properties the
 * mapper saw.
 */
async function deliverAndCaptureProperties(options: {
  projectPolicies?: ReadonlyMap<string, ProjectPolicyOverride>;
  envelope?: NormalizableEnvelope;
}): Promise<Readonly<Record<string, unknown>>> {
  const seen: Array<Readonly<Record<string, unknown>>> = [];

  const mapper: Mapper<{ ok: true }> = (ctx) => {
    seen.push(ctx.normalized.properties);
    return { kind: "mapped", payload: { ok: true } };
  };
  const deliverer: Deliverer<{ ok: true }> = async () => ({
    kind: "accepted",
    vendor_response_code: "200",
    vendor_response_summary: "ok",
  });

  const descriptor: DestinationDescriptor<{ ok: true }> = {
    identity: {
      vendor: "test-vendor",
      component: "test-vendor",
      consumerVersion: "v1",
      normalizeVersion: "v1",
      mapperVersion: "v1",
      delivererVersion: "v1",
    },
    mappers: { "payment.approved": mapper },
    deliverer,
    requiredConsent: {},
  };

  const instances = new InMemoryDestinationInstanceReader();
  instances.set(INSTANCE);

  const runtime = createDestinationConsumer({
    descriptor,
    consumer: {
      subscribe: async () => {},
      runEach: async () => {},
      disconnect: async () => {},
    } as unknown as Parameters<typeof createDestinationConsumer>[0]["consumer"],
    producer: {
      publishToQueue: async () => {},
    } as unknown as Parameters<typeof createDestinationConsumer>[0]["producer"],
    instances,
    records: new InMemoryDeliveryRecordRepository(),
    dedupe: new InMemoryDestinationDedupe(),
    logger: noopLogger,
    ...(options.projectPolicies !== undefined ? { projectPolicies: options.projectPolicies } : {}),
  });

  await runtime.handleEvent({
    envelope: options.envelope ?? makeEnvelope(),
    destination_id: INSTANCE.destination_id,
  });

  const properties = seen[0];
  expect(properties, "the mapper was never reached").toBeDefined();
  return properties as Readonly<Record<string, unknown>>;
}

describe("destination second pass — project policy override", () => {
  it("carries the raw value through when no override is wired", async () => {
    // The pre-fix behaviour, kept as the control. If this ever starts
    // redacting, the difference asserted below stops proving anything.
    const properties = await deliverAndCaptureProperties({});
    expect(properties["email"]).toBe(RAW_EMAIL);
  });

  it("redacts the value when the project's override is wired", async () => {
    const properties = await deliverAndCaptureProperties({
      projectPolicies: new Map([["checkout", CHECKOUT_LIKE_OVERRIDE]]),
    });
    expect(properties["email"]).not.toBe(RAW_EMAIL);
    expect(String(properties["email"])).toMatch(/^\[REDACTED:/);
  });

  it("leaves other properties untouched", async () => {
    const properties = await deliverAndCaptureProperties({
      projectPolicies: new Map([["checkout", CHECKOUT_LIKE_OVERRIDE]]),
    });
    expect(properties["amount"]).toBe(4200);
    expect(properties["currency"]).toBe("USD");
  });

  it("applies no override to a project the map does not name", async () => {
    // Absent override = platform defaults, for the destination pass too.
    const properties = await deliverAndCaptureProperties({
      projectPolicies: new Map([["some-other-project", CHECKOUT_LIKE_OVERRIDE]]),
    });
    expect(properties["email"]).toBe(RAW_EMAIL);
  });

  it("keys the override off the envelope's project_id, not the instance's", async () => {
    // The instance is `checkout`; the event is not. Policy belongs to the
    // data, so the event's project decides — and here that means no
    // override applies even though the instance's project has one.
    const properties = await deliverAndCaptureProperties({
      projectPolicies: new Map([["checkout", CHECKOUT_LIKE_OVERRIDE]]),
      envelope: makeEnvelope({ project_id: "visiting-project" }),
    });
    expect(properties["email"]).toBe(RAW_EMAIL);
  });
});
