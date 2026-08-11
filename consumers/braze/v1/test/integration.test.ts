/**
 * App-level integration test for the braze v1 consumer.
 *
 * Drives `createDestinationConsumer({...}).handleEvent({...})` with the
 * braze descriptor and in-memory adapters so the full pipeline runs
 * end-to-end without a RabbitMQ broker or PostgreSQL:
 *
 *   envelope → normalize → map (per-event) → deliver (fake fetch)
 *           → RECORD (in-memory delivery_records [+ dlq_records on
 *             permanent / threshold-retryable])
 *
 * Also exercises Polaris-side delivery-key idempotency — Braze does not
 * provide a generic vendor event dedupe, so the runtime's
 * delivery-records-based short-circuit IS the canonical guard against
 * double-delivery. Tests pin the contract end-to-end.
 *
 * @see docs/architecture/06-destinations.md "Destination Consumer"
 */

import {
  createDestinationConsumer,
  InMemoryDeliveryRecordRepository,
  InMemoryDestinationInstanceReader,
  InMemoryDlqRecordRepository,
  type NormalizableEnvelope,
  type PolarisProducer,
} from "@polaris/shared-destinations";
import { createLogger } from "@polaris/shared-logger";
import { SecretResolver } from "@polaris/shared-secrets";
import { describe, expect, it } from "vitest";

import { createBrazeDescriptor } from "../src/descriptor.js";
import { fixtureDestinationInstance } from "./fixtures/normalized.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface FetchCall {
  readonly url: string;
  readonly body: string;
  readonly headers: Record<string, string>;
}

function makeFetch(responder: () => Response | Promise<Response>): {
  fetch: typeof globalThis.fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  return {
    calls,
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      const headers: Record<string, string> = {};
      const initHeaders = init?.headers ?? {};
      if (initHeaders instanceof Headers) {
        initHeaders.forEach((value, key) => {
          headers[key.toLowerCase()] = value;
        });
      } else if (Array.isArray(initHeaders)) {
        for (const [k, v] of initHeaders) headers[String(k).toLowerCase()] = String(v);
      } else {
        for (const [k, v] of Object.entries(initHeaders))
          headers[String(k).toLowerCase()] = String(v);
      }
      calls.push({
        url,
        body: typeof init?.body === "string" ? init.body : String(init?.body ?? ""),
        headers,
      });
      return responder();
    },
  };
}

const NOOP_PRODUCER = {
  connect: async () => undefined,
  disconnect: async () => undefined,
  isConnected: () => true,
  publish: async () => ({ stream: "analytics.events-0", partition: 0 }),
  publishEvent: async () => ({ stream: "analytics.events-0", partition: 0 }),
  publishToQueue: async () => undefined,
} as unknown as PolarisProducer;

function makeSecretResolver(map: Record<string, string>): SecretResolver {
  return new SecretResolver({
    adapters: {
      env: {
        async getSecret(ref: string) {
          const value = map[ref];
          if (value === undefined) throw new Error(`secret not found: env:${ref}`);
          return value;
        },
      },
    },
  });
}

function fixtureEnvelope(overrides: Partial<NormalizableEnvelope> = {}): NormalizableEnvelope {
  return {
    event_id: "evt_int_braze_001",
    event: "checkout.started",
    schema_version: 1,
    project_id: "storefront",
    environment: "production",
    occurred_at: "2026-05-14T12:00:00.000Z",
    ingested_at: "2026-05-14T12:00:00.500Z",
    source: { id: "storefront-web", type: "frontend" },
    identity: {
      customer_id: "cust_int_braze",
      anonymous_id: "anon_int_braze",
    },
    context: {
      ip: "203.0.113.42",
      user_agent: "Mozilla/5.0",
      page: { url: "https://storefront.example/checkout" },
    },
    // The Braze descriptor's `identityFromProperties` hook surfaces
    // `email` / `phone` from `properties` into the prepared identity.
    properties: {
      cart_id: "cart_42",
      total: 19995,
      currency: "USD",
      items: [{ sku: "sku-1", name: "Widget", quantity: 2, unit_price: 4999 }],
      email: "buyer@storefront.example",
      phone: "+15555550199",
    },
    consent: { marketing: true, analytics: true, personalization: true },
    ...overrides,
  };
}

const SECRET = JSON.stringify({
  instance: "iad-01",
  api_key: "br-test-api-key-xyz123456",
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("braze v1 integration (handleEvent driven)", () => {
  const logger = createLogger({
    service: "test",
    version: "v1",
    env: "test",
    level: "fatal",
  });

  it("delivers a checkout.started event and writes status=accepted", async () => {
    const { fetch, calls } = makeFetch(
      () => new Response('{"message":"success"}', { status: 200 }),
    );

    const instance = fixtureDestinationInstance();
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();
    const secrets = makeSecretResolver({ BRAZE_SECRET: SECRET });

    const descriptor = createBrazeDescriptor({
      fetch,
      requestTimeoutMs: 5000,
      apiHost: "rest.{instance}.braze.test",
    });
    const runtime = createDestinationConsumer({
      descriptor,
      consumer: {} as never,
      producer: NOOP_PRODUCER,
      instances,
      records,
      secrets,
      logger,
    });

    const record = await runtime.handleEvent({
      envelope: fixtureEnvelope(),
      destination_id: instance.destination_id,
    });

    expect(record?.status).toBe("accepted");
    expect(record?.consumer_version).toBe("v1");
    expect(record?.mapper_version).toBe("v1");
    expect(record?.deliverer_version).toBe("v1");
    expect(record?.normalize_version).toBe("v1");
    // Audit-only — Braze ignores the field, but the runtime stamps the
    // canonical event_id onto delivery_records for receiver-side debug.
    expect(record?.dedupe_key).toBe("evt_int_braze_001");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://rest.iad-01.braze.test/users/track");
    expect(calls[0]?.headers["authorization"]).toBe("Bearer br-test-api-key-xyz123456");
    const body = JSON.parse(calls[0]?.body ?? "");
    expect(body.events).toHaveLength(1);
    expect(body.events[0].name).toBe("checkout_started");
    expect(body.events[0].external_id).toBe("cust_int_braze");
    expect(body.events[0].time).toBe("2026-05-14T12:00:00.000Z");
  });

  it("delivers a payment.approved event as a purchases[] entry", async () => {
    const { fetch, calls } = makeFetch(
      () => new Response('{"message":"success"}', { status: 200 }),
    );

    const instance = fixtureDestinationInstance();
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();
    const secrets = makeSecretResolver({ BRAZE_SECRET: SECRET });

    const descriptor = createBrazeDescriptor({ fetch, requestTimeoutMs: 5000 });
    const runtime = createDestinationConsumer({
      descriptor,
      consumer: {} as never,
      producer: NOOP_PRODUCER,
      instances,
      records,
      secrets,
      logger,
    });

    const record = await runtime.handleEvent({
      envelope: fixtureEnvelope({
        event: "payment.approved",
        properties: { amount_minor: 4999, currency: "USD", order_id: "ord_int_001" },
      }),
      destination_id: instance.destination_id,
    });

    expect(record?.status).toBe("accepted");
    const body = JSON.parse(calls[0]?.body ?? "");
    expect(body.purchases).toHaveLength(1);
    expect(body.purchases[0].price).toBe(49.99);
    expect(body.purchases[0].currency).toBe("USD");
    expect(body.purchases[0].product_id).toBe("ord_int_001");
    expect(body.events).toBeUndefined();
  });

  it("delivers a user.identified event as an attributes[] entry with raw email + _update_existing_only=false", async () => {
    const { fetch, calls } = makeFetch(
      () => new Response('{"message":"success"}', { status: 200 }),
    );

    const instance = fixtureDestinationInstance();
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();
    const secrets = makeSecretResolver({ BRAZE_SECRET: SECRET });

    const descriptor = createBrazeDescriptor({ fetch, requestTimeoutMs: 5000 });
    const runtime = createDestinationConsumer({
      descriptor,
      consumer: {} as never,
      producer: NOOP_PRODUCER,
      instances,
      records,
      secrets,
      logger,
    });

    const record = await runtime.handleEvent({
      envelope: fixtureEnvelope({ event: "user.identified" }),
      destination_id: instance.destination_id,
    });

    expect(record?.status).toBe("accepted");
    const body = JSON.parse(calls[0]?.body ?? "");
    expect(body.attributes).toHaveLength(1);
    expect(body.attributes[0].external_id).toBe("cust_int_braze");
    expect(body.attributes[0]._update_existing_only).toBe(false);
    // Raw email — NOT hashed.
    expect(body.attributes[0].email).toBe("buyer@storefront.example");
    expect(body.attributes[0].phone).toBe("+15555550199");
  });

  it("drops events when required marketing consent is denied", async () => {
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const instance = fixtureDestinationInstance();
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();
    const secrets = makeSecretResolver({ BRAZE_SECRET: SECRET });

    const descriptor = createBrazeDescriptor({ fetch, requestTimeoutMs: 5000 });
    const runtime = createDestinationConsumer({
      descriptor,
      consumer: {} as never,
      producer: NOOP_PRODUCER,
      instances,
      records,
      secrets,
      logger,
    });

    const record = await runtime.handleEvent({
      envelope: fixtureEnvelope({
        consent: { marketing: false, analytics: true, personalization: true },
      }),
      destination_id: instance.destination_id,
    });

    expect(record?.status).toBe("dropped_consent");
    expect(record?.error_class).toBe("consent");
    expect(calls).toHaveLength(0);
  });

  it("writes mapped_failed for unsupported canonical events", async () => {
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const instance = fixtureDestinationInstance();
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();
    const secrets = makeSecretResolver({ BRAZE_SECRET: SECRET });

    const descriptor = createBrazeDescriptor({ fetch, requestTimeoutMs: 5000 });
    const runtime = createDestinationConsumer({
      descriptor,
      consumer: {} as never,
      producer: NOOP_PRODUCER,
      instances,
      records,
      secrets,
      logger,
    });

    const record = await runtime.handleEvent({
      envelope: fixtureEnvelope({ event: "page.viewed" }),
      destination_id: instance.destination_id,
    });

    expect(record?.status).toBe("mapped_failed");
    expect(record?.error_class).toBe("mapping");
    expect(record?.vendor_response_summary).toContain("page.viewed");
    expect(calls).toHaveLength(0);
  });

  it("suppresses replay traffic by default (no delivery, no record)", async () => {
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const instance = fixtureDestinationInstance();
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();
    const secrets = makeSecretResolver({ BRAZE_SECRET: SECRET });

    const descriptor = createBrazeDescriptor({ fetch, requestTimeoutMs: 5000 });
    const runtime = createDestinationConsumer({
      descriptor,
      consumer: {} as never,
      producer: NOOP_PRODUCER,
      instances,
      records,
      secrets,
      logger,
      // allowReplay defaults to false.
    });

    const record = await runtime.handleEvent({
      envelope: fixtureEnvelope(),
      destination_id: instance.destination_id,
      is_replay: true,
    });

    expect(record).toBeNull();
    expect(calls).toHaveLength(0);
    expect(records.snapshot()).toHaveLength(0);
  });

  it("Polaris delivery-key idempotency short-circuits a duplicate envelope (Braze has no vendor dedupe)", async () => {
    // This is the canonical divergence the manifest references:
    // Braze re-records duplicate events with the same
    // (external_id, name, time). The Polaris runtime's delivery-key
    // idempotency check is the guard. We invoke handleEvent twice with
    // the same envelope and assert only one delivery happens.
    const { fetch, calls } = makeFetch(
      () => new Response('{"message":"success"}', { status: 200 }),
    );
    const instance = fixtureDestinationInstance();
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();
    const secrets = makeSecretResolver({ BRAZE_SECRET: SECRET });

    const descriptor = createBrazeDescriptor({ fetch, requestTimeoutMs: 5000 });
    const runtime = createDestinationConsumer({
      descriptor,
      consumer: {} as never,
      producer: NOOP_PRODUCER,
      instances,
      records,
      secrets,
      logger,
    });

    const envelope = fixtureEnvelope();
    const first = await runtime.handleEvent({
      envelope,
      destination_id: instance.destination_id,
    });
    expect(first?.status).toBe("accepted");
    expect(calls).toHaveLength(1);

    // Replay the same envelope.
    const second = await runtime.handleEvent({
      envelope,
      destination_id: instance.destination_id,
    });
    // Polaris-side guard: the runtime's dedupe table short-circuits the
    // duplicate envelope without invoking the deliverer. handleEvent
    // returns `null` (no new delivery record); Braze never sees the
    // duplicate request. This is the canonical guard for Braze because
    // the vendor itself does not provide event-dedupe semantics.
    expect(calls).toHaveLength(1);
    expect(second).toBeNull();
  });

  it("maps a 401 to failed_permanent + auth and writes a dlq_records row", async () => {
    const { fetch } = makeFetch(() => new Response("nope", { status: 401 }));
    const instance = fixtureDestinationInstance();
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();
    const dlqRecords = new InMemoryDlqRecordRepository();
    const secrets = makeSecretResolver({ BRAZE_SECRET: SECRET });

    const descriptor = createBrazeDescriptor({ fetch, requestTimeoutMs: 5000 });
    const runtime = createDestinationConsumer({
      descriptor,
      consumer: {} as never,
      producer: NOOP_PRODUCER,
      instances,
      records,
      dlqRecords,
      secrets,
      logger,
    });

    const record = await runtime.handleEvent({
      envelope: fixtureEnvelope(),
      destination_id: instance.destination_id,
      payload: {
        topic: "analytics.events",
        partition: 0,
        message: {
          value: Buffer.from(JSON.stringify(fixtureEnvelope()), "utf8"),
          headers: {},
          offset: "1",
          timestamp: "0",
          attributes: 0,
          size: 0,
          key: null,
        },
        heartbeat: async () => {},
        pause: () => () => {},
      },
    });

    expect(record?.status).toBe("failed_permanent");
    expect(record?.error_class).toBe("auth");
    const dlq = dlqRecords.snapshot();
    expect(dlq).toHaveLength(1);
    expect(dlq[0]?.error_class).toBe("auth");
    expect(dlq[0]?.vendor).toBe("braze");
  });
});
