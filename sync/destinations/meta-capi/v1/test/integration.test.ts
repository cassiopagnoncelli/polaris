/**
 * App-level integration test for the meta-capi v1 consumer.
 *
 * Drives `createDestinationConsumer({...}).handleEvent({...})` with the
 * meta-capi descriptor and in-memory adapters so the full pipeline runs
 * end-to-end without a RabbitMQ broker or PostgreSQL:
 *
 *   envelope → normalize → map (per-event) → deliver (fake fetch)
 *           → RECORD (in-memory delivery_records [+ dlq_records on
 *             permanent / threshold-retryable])
 *
 * @see docs/architecture/06-destinations.md "Destination Consumer"
 */

import type { NormalizableEnvelope } from "@polaris/shared-destination-normalize";
import {
  createDestinationConsumer,
  InMemoryDeliveryRecordRepository,
  InMemoryDestinationInstanceReader,
  InMemoryDlqRecordRepository,
} from "@polaris/shared-destinations";
import { createLogger } from "@polaris/shared-logger";
import type { PolarisProducer } from "@polaris/shared-transport";
import { describe, expect, it } from "vitest";

import { createMetaCapiDescriptor } from "../src/descriptor.js";
import { fixtureDestinationInstance } from "./fixtures/normalized.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface FetchCall {
  readonly url: string;
  readonly body: string;
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
      calls.push({
        url,
        body: typeof init?.body === "string" ? init.body : String(init?.body ?? ""),
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

function fixtureEnvelope(overrides: Partial<NormalizableEnvelope> = {}): NormalizableEnvelope {
  return {
    event_id: "evt_int_meta_001",
    event: "checkout.started",
    schema_version: 1,
    project_id: "storefront",
    environment: "production",
    occurred_at: "2026-05-14T12:00:00.000Z",
    ingested_at: "2026-05-14T12:00:00.500Z",
    source: { id: "storefront-web", type: "frontend" },
    identity: {
      customer_id: "cust_int_meta",
      anonymous_id: "anon_int_meta",
    },
    context: {
      ip: "203.0.113.42",
      user_agent: "Mozilla/5.0",
      page: { url: "https://storefront.example/checkout" },
    },
    properties: {
      cart_id: "cart_42",
      total: 19995,
      currency: "USD",
      items: [{ sku: "sku-1", name: "Widget", quantity: 2, unit_price: 4999 }],
    },
    consent: { marketing: true, analytics: true, personalization: true },
    ...overrides,
  };
}

const SECRET = JSON.stringify({
  pixel_id: "1234567890",
  access_token: "EAAB-test-token",
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("meta-capi v1 integration (handleEvent driven)", () => {
  const logger = createLogger({
    service: "test",
    version: "v1",
    env: "test",
    level: "fatal",
  });

  it("delivers a checkout.started event and writes status=accepted", async () => {
    const { fetch, calls } = makeFetch(
      () => new Response('{"events_received":1,"fbtrace_id":"trace_abc"}', { status: 200 }),
    );

    const instance = fixtureDestinationInstance(SECRET);
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();

    const descriptor = createMetaCapiDescriptor({
      fetch,
      requestTimeoutMs: 5000,
      graphHost: "graph.facebook.test",
    });
    const runtime = createDestinationConsumer({
      descriptor,
      consumer: {} as never,
      producer: NOOP_PRODUCER,
      instances,
      records,
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
    expect(record?.normalize_version).toBe("v2");
    // Vendor dedupe_key stamped on the record IS the canonical event_id.
    expect(record?.dedupe_key).toBe("evt_int_meta_001");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/1234567890/events");
    const body = JSON.parse(calls[0]?.body ?? "");
    expect(body.data[0].event_name).toBe("InitiateCheckout");
    expect(body.data[0].event_id).toBe("evt_int_meta_001");
  });

  it("drops events when required marketing consent is denied", async () => {
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const instance = fixtureDestinationInstance(SECRET);
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();

    const descriptor = createMetaCapiDescriptor({ fetch, requestTimeoutMs: 5000 });
    const runtime = createDestinationConsumer({
      descriptor,
      consumer: {} as never,
      producer: NOOP_PRODUCER,
      instances,
      records,
      logger,
    });

    const record = await runtime.handleEvent({
      envelope: fixtureEnvelope({
        consent: { marketing: false, analytics: true, personalization: true },
      }),
      destination_id: instance.destination_id,
    });

    // Normalize layer drops on consent → `dropped_consent` record.
    expect(record?.status).toBe("dropped_consent");
    expect(record?.error_class).toBe("consent");
    expect(calls).toHaveLength(0);
  });

  it("writes skipped_unmapped for unsupported canonical events", async () => {
    // Was `mapped_failed` until H05QEWIB. This vendor registers mappers for
    // the events it models; one it does not model is routine operation, not
    // a mapping fault, and `error_class` stays null so the two remain
    // distinguishable in delivery_records and on the dashboards.
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const instance = fixtureDestinationInstance(SECRET);
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();

    const descriptor = createMetaCapiDescriptor({ fetch, requestTimeoutMs: 5000 });
    const runtime = createDestinationConsumer({
      descriptor,
      consumer: {} as never,
      producer: NOOP_PRODUCER,
      instances,
      records,
      logger,
    });

    const record = await runtime.handleEvent({
      envelope: fixtureEnvelope({ event: "page.viewed" }),
      destination_id: instance.destination_id,
    });

    expect(record?.status).toBe("skipped_unmapped");
    expect(record?.error_class).toBeNull();
    expect(record?.vendor_response_summary).toContain("page.viewed");
    expect(calls).toHaveLength(0);
  });

  it("suppresses replay traffic by default (no delivery, no record)", async () => {
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const instance = fixtureDestinationInstance(SECRET);
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();

    const descriptor = createMetaCapiDescriptor({ fetch, requestTimeoutMs: 5000 });
    const runtime = createDestinationConsumer({
      descriptor,
      consumer: {} as never,
      producer: NOOP_PRODUCER,
      instances,
      records,
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

  it("delivers a signup.completed event as CompleteRegistration", async () => {
    const { fetch, calls } = makeFetch(
      () => new Response('{"events_received":1,"fbtrace_id":"trace_signup"}', { status: 200 }),
    );
    const instance = fixtureDestinationInstance(SECRET);
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();

    const descriptor = createMetaCapiDescriptor({ fetch, requestTimeoutMs: 5000 });
    const runtime = createDestinationConsumer({
      descriptor,
      consumer: {} as never,
      producer: NOOP_PRODUCER,
      instances,
      records,
      logger,
    });

    const record = await runtime.handleEvent({
      envelope: fixtureEnvelope({
        event_id: "evt_int_meta_signup",
        event: "signup.completed",
        properties: { currency: "USD", predicted_ltv_minor: 9999 },
      }),
      destination_id: instance.destination_id,
    });

    expect(record?.status).toBe("accepted");
    const body = JSON.parse(calls[0]?.body ?? "");
    expect(body.data[0].event_name).toBe("CompleteRegistration");
    expect(body.data[0].custom_data).toEqual({ currency: "USD", predicted_ltv: 99.99 });
  });

  it("delivers a subscription.renewed event as Subscribe with value + ltv + subscription order_id", async () => {
    const { fetch, calls } = makeFetch(
      () => new Response('{"events_received":1,"fbtrace_id":"trace_sub"}', { status: 200 }),
    );
    const instance = fixtureDestinationInstance(SECRET);
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();

    const descriptor = createMetaCapiDescriptor({ fetch, requestTimeoutMs: 5000 });
    const runtime = createDestinationConsumer({
      descriptor,
      consumer: {} as never,
      producer: NOOP_PRODUCER,
      instances,
      records,
      logger,
    });

    const record = await runtime.handleEvent({
      envelope: fixtureEnvelope({
        event_id: "evt_int_meta_sub",
        event: "subscription.renewed",
        properties: {
          subscription_id: "sub_42",
          amount_minor: 1999,
          currency: "USD",
          predicted_ltv_minor: 99999,
        },
      }),
      destination_id: instance.destination_id,
    });

    expect(record?.status).toBe("accepted");
    const body = JSON.parse(calls[0]?.body ?? "");
    expect(body.data[0].event_name).toBe("Subscribe");
    expect(body.data[0].custom_data).toEqual({
      currency: "USD",
      value: 19.99,
      predicted_ltv: 999.99,
      order_id: "sub_42",
    });
  });

  it("maps a 401 to failed_permanent + auth and writes a dlq_records row", async () => {
    const { fetch } = makeFetch(() => new Response("nope", { status: 401 }));
    const instance = fixtureDestinationInstance(SECRET);
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();
    const dlqRecords = new InMemoryDlqRecordRepository();

    const descriptor = createMetaCapiDescriptor({ fetch, requestTimeoutMs: 5000 });
    const runtime = createDestinationConsumer({
      descriptor,
      consumer: {} as never,
      producer: NOOP_PRODUCER,
      instances,
      records,
      dlqRecords,
      logger,
    });

    const record = await runtime.handleEvent({
      envelope: fixtureEnvelope(),
      destination_id: instance.destination_id,
      payload: {
        stream: "analytics.events-0",
        family: "analytics.events",
        partition: 0,
        message: {
          value: Buffer.from(JSON.stringify(fixtureEnvelope()), "utf8"),
          headers: {},
          offset: "1",
          timestamp: "0",
          key: null,
          redelivered: false,
        },
      },
    });

    expect(record?.status).toBe("failed_permanent");
    expect(record?.error_class).toBe("auth");
    const dlq = dlqRecords.snapshot();
    expect(dlq).toHaveLength(1);
    expect(dlq[0]?.error_class).toBe("auth");
    expect(dlq[0]?.vendor).toBe("meta-capi");
  });
});
