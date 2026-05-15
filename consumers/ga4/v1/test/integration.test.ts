/**
 * App-level integration test for the ga4 v1 consumer.
 *
 * Drives `createDestinationConsumer({...}).handleEvent({...})` with the
 * ga4 descriptor and in-memory adapters so the full pipeline runs
 * end-to-end without a Redpanda broker or PostgreSQL:
 *
 *   envelope → normalize → map (per-event) → deliver (fake fetch)
 *           → RECORD (in-memory delivery_records [+ dlq_records on
 *             permanent / threshold-retryable])
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

import { createGa4Descriptor } from "../src/descriptor.js";
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
  send: async () => undefined,
  sendBatch: async () => undefined,
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
    event_id: "evt_int_ga4_001",
    event: "checkout.started",
    schema_version: 1,
    project_id: "storefront",
    environment: "production",
    occurred_at: "2026-05-14T12:00:00.000Z",
    ingested_at: "2026-05-14T12:00:00.500Z",
    source: { id: "storefront-web", type: "frontend" },
    identity: {
      customer_id: "cust_int_ga4",
      anonymous_id: "anon_int_ga4",
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
  measurement_id: "G-TEST123456",
  api_secret: "ga4-int-api-secret",
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ga4 v1 integration (handleEvent driven)", () => {
  const logger = createLogger({
    service: "test",
    version: "v1",
    env: "test",
    level: "fatal",
  });

  it("delivers a checkout.started event and writes status=accepted on HTTP 204", async () => {
    const { fetch, calls } = makeFetch(() => new Response(null, { status: 204 }));

    const instance = fixtureDestinationInstance();
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();
    const secrets = makeSecretResolver({ GA4_SECRET: SECRET });

    const descriptor = createGa4Descriptor({
      fetch,
      requestTimeoutMs: 5000,
      apiHost: "www.google-analytics.test",
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
    // For begin_checkout, dedupe_key falls through to canonical event_id
    // (GA4 only dedupes purchases via transaction_id).
    expect(record?.dedupe_key).toBe("evt_int_ga4_001");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/mp/collect?");
    expect(calls[0]?.url).toContain("measurement_id=G-TEST123456");
    const body = JSON.parse(calls[0]?.body ?? "");
    expect(body.events).toHaveLength(1);
    expect(body.events[0].name).toBe("begin_checkout");
  });

  it("stamps purchase.transaction_id as the dedupe_key for payment.approved", async () => {
    const { fetch } = makeFetch(() => new Response(null, { status: 204 }));

    const instance = fixtureDestinationInstance();
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();
    const secrets = makeSecretResolver({ GA4_SECRET: SECRET });

    const descriptor = createGa4Descriptor({ fetch, requestTimeoutMs: 5000 });
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
        properties: {
          amount_minor: 4999,
          currency: "USD",
          transaction_id: "tx_int_999",
        },
      }),
      destination_id: instance.destination_id,
    });

    expect(record?.status).toBe("accepted");
    // CRITICAL: cross-channel purchase dedupe leans on transaction_id.
    expect(record?.dedupe_key).toBe("tx_int_999");
  });

  it("drops events when required analytics consent is denied", async () => {
    const { fetch, calls } = makeFetch(() => new Response(null, { status: 204 }));
    const instance = fixtureDestinationInstance();
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();
    const secrets = makeSecretResolver({ GA4_SECRET: SECRET });

    const descriptor = createGa4Descriptor({ fetch, requestTimeoutMs: 5000 });
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
        consent: { marketing: true, analytics: false, personalization: true },
      }),
      destination_id: instance.destination_id,
    });

    // Normalize layer drops on consent → `dropped_consent` record.
    expect(record?.status).toBe("dropped_consent");
    expect(record?.error_class).toBe("consent");
    expect(calls).toHaveLength(0);
  });

  it("writes mapped_failed for unsupported canonical events", async () => {
    const { fetch, calls } = makeFetch(() => new Response(null, { status: 204 }));
    const instance = fixtureDestinationInstance();
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();
    const secrets = makeSecretResolver({ GA4_SECRET: SECRET });

    const descriptor = createGa4Descriptor({ fetch, requestTimeoutMs: 5000 });
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
    const { fetch, calls } = makeFetch(() => new Response(null, { status: 204 }));
    const instance = fixtureDestinationInstance();
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();
    const secrets = makeSecretResolver({ GA4_SECRET: SECRET });

    const descriptor = createGa4Descriptor({ fetch, requestTimeoutMs: 5000 });
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

  it("maps a 401 to failed_permanent + auth and writes a dlq_records row", async () => {
    const { fetch } = makeFetch(() => new Response("nope", { status: 401 }));
    const instance = fixtureDestinationInstance();
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();
    const dlqRecords = new InMemoryDlqRecordRepository();
    const secrets = makeSecretResolver({ GA4_SECRET: SECRET });

    const descriptor = createGa4Descriptor({ fetch, requestTimeoutMs: 5000 });
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
    expect(dlq[0]?.vendor).toBe("ga4");
  });
});
