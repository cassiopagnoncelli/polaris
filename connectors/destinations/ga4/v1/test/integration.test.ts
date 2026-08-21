/**
 * App-level integration test for the ga4 v1 consumer.
 *
 * Drives `createDestinationConsumer({...}).handleEvent({...})` with the
 * ga4 descriptor and in-memory adapters so the full pipeline runs
 * end-to-end without a RabbitMQ broker or PostgreSQL:
 *
 *   envelope → normalize → map (per-event) → deliver (fake fetch)
 *           → RECORD (in-memory delivery_records [+ dlq_records on
 *             permanent / threshold-retryable])
 *
 * @see docs/architecture/06-destinations.md "Destination Consumer"
 */

import type { NormalizableEnvelope } from "@polaris/delivery-normalize";
import {
  createDestinationConsumer,
  InMemoryDeliveryRecordRepository,
  InMemoryDestinationInstanceReader,
  InMemoryDlqRecordRepository,
} from "@polaris/delivery-destinations";
import { createLogger } from "@polaris/observability-logger";
import type { PolarisProducer } from "@polaris/bus";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readFileSync } from "node:fs";

import { createGa4Descriptor } from "../src/connector.js";
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

    const instance = fixtureDestinationInstance(SECRET);
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();

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
    expect(record?.normalize_version).toBe("v3");
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

    const instance = fixtureDestinationInstance(SECRET);
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();

    const descriptor = createGa4Descriptor({ fetch, requestTimeoutMs: 5000 });
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
    const instance = fixtureDestinationInstance(SECRET);
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();

    const descriptor = createGa4Descriptor({ fetch, requestTimeoutMs: 5000 });
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
        consent: { marketing: true, analytics: false, personalization: true },
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
    const { fetch, calls } = makeFetch(() => new Response(null, { status: 204 }));
    const instance = fixtureDestinationInstance(SECRET);
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();

    const descriptor = createGa4Descriptor({ fetch, requestTimeoutMs: 5000 });
    const runtime = createDestinationConsumer({
      descriptor,
      consumer: {} as never,
      producer: NOOP_PRODUCER,
      instances,
      records,
      logger,
    });

    const record = await runtime.handleEvent({
      envelope: fixtureEnvelope({ event: "session.started" }),
      destination_id: instance.destination_id,
    });

    expect(record?.status).toBe("skipped_unmapped");
    expect(record?.error_class).toBeNull();
    expect(record?.vendor_response_summary).toContain("session.started");
    expect(calls).toHaveLength(0);
  });

  it("suppresses replay traffic by default (no delivery, no record)", async () => {
    const { fetch, calls } = makeFetch(() => new Response(null, { status: 204 }));
    const instance = fixtureDestinationInstance(SECRET);
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();

    const descriptor = createGa4Descriptor({ fetch, requestTimeoutMs: 5000 });
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

  it("delivers a signup.completed event as sign_up with method='polaris'", async () => {
    const { fetch, calls } = makeFetch(() => new Response(null, { status: 204 }));
    const instance = fixtureDestinationInstance(SECRET);
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();

    const descriptor = createGa4Descriptor({ fetch, requestTimeoutMs: 5000 });
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
        event_id: "evt_int_ga4_signup",
        event: "signup.completed",
        properties: { registration_method: "email" },
      }),
      destination_id: instance.destination_id,
    });

    expect(record?.status).toBe("accepted");
    expect(record?.dedupe_key).toBe("evt_int_ga4_signup");
    const body = JSON.parse(calls[0]?.body ?? "");
    expect(body.events[0].name).toBe("sign_up");
    expect(body.events[0].params).toMatchObject({ method: "polaris" });
  });

  it("delivers a subscription.renewed event as subscription_renewed with currency + value + transaction_id", async () => {
    const { fetch, calls } = makeFetch(() => new Response(null, { status: 204 }));
    const instance = fixtureDestinationInstance(SECRET);
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();

    const descriptor = createGa4Descriptor({ fetch, requestTimeoutMs: 5000 });
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
        event_id: "evt_int_ga4_sub",
        event: "subscription.renewed",
        properties: {
          subscription_id: "sub_42",
          amount_minor: 1999,
          currency: "USD",
        },
      }),
      destination_id: instance.destination_id,
    });

    expect(record?.status).toBe("accepted");
    // GA4 does not dedupe custom events; Polaris-side key stays on event_id.
    expect(record?.dedupe_key).toBe("evt_int_ga4_sub");
    const body = JSON.parse(calls[0]?.body ?? "");
    expect(body.events[0].name).toBe("subscription_renewed");
    expect(body.events[0].params).toMatchObject({
      currency: "USD",
      value: 19.99,
      transaction_id: "sub_42",
    });
  });

  it("maps a 401 to failed_permanent + auth and writes a dlq_records row", async () => {
    const { fetch } = makeFetch(() => new Response("nope", { status: 401 }));
    const instance = fixtureDestinationInstance(SECRET);
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();
    const dlqRecords = new InMemoryDlqRecordRepository();

    const descriptor = createGa4Descriptor({ fetch, requestTimeoutMs: 5000 });
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
    expect(dlq[0]?.vendor).toBe("ga4");
  });
});

// ---------------------------------------------------------------------------
// Golden request bodies (1QKDI)
// ---------------------------------------------------------------------------

/**
 * The `*.input.json` / `*.output.json` pairs, run through the real
 * pipeline and compared byte-for-byte.
 *
 * They were illustrative until now, asserted by nothing, and they had
 * drifted into fiction: both showed `user_id` and `timestamp_micros`,
 * neither of which this connector had ever sent. A golden no test reads
 * documents what somebody once intended. These are the wire, or they fail.
 *
 * The clock is pinned an hour after each fixture's `occurred_at`, because
 * `timestamp_micros` is withheld outside GA4's 72-hour window — against a
 * real clock the goldens would encode "an event delivered promptly" this
 * week and "an event delivered late" next week.
 */
describe("golden request bodies", () => {
  const logger = createLogger({ service: "test", version: "v1", env: "test", level: "fatal" });
  const SECRET_WEB = JSON.stringify({
    measurement_id: "G-TEST123456",
    api_secret: "ga4-golden-api-secret",
  });
  const SECRET_APP = JSON.stringify({
    measurement_id: "G-TEST123456",
    api_secret: "ga4-golden-api-secret",
    firebase_app_id: "1:NNN:ios:abcdef",
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function readFixture(name: string): Record<string, unknown> {
    return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
  }

  async function deliverGolden(name: string, secret: string): Promise<unknown> {
    const envelope = readFixture(`${name}.input.json`) as unknown as NormalizableEnvelope;
    // Only `Date` is faked: the deliverer arms a real `setTimeout` for its
    // per-attempt abort, and a fake timer would leave it unfired forever.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(envelope.occurred_at) + 60 * 60 * 1000);

    const { fetch, calls } = makeFetch(() => new Response(null, { status: 204 }));
    const instance = {
      ...fixtureDestinationInstance(secret),
      destination_id: "polaris_dst_golden",
    };
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);

    const runtime = createDestinationConsumer({
      descriptor: createGa4Descriptor({ fetch, requestTimeoutMs: 5000 }),
      consumer: {} as never,
      producer: NOOP_PRODUCER,
      instances,
      records: new InMemoryDeliveryRecordRepository(),
      logger,
    });
    const record = await runtime.handleEvent({
      envelope,
      destination_id: instance.destination_id,
    });
    expect(record?.status).toBe("accepted");
    return JSON.parse(calls[0]?.body ?? "null");
  }

  for (const [name, secret] of [
    ["checkout-started", SECRET_WEB],
    ["page-viewed", SECRET_WEB],
    ["signup-completed", SECRET_WEB],
    ["subscription-renewed", SECRET_WEB],
    ["app-source-purchase", SECRET_APP],
  ] as const) {
    it(`${name} matches its golden`, async () => {
      expect(await deliverGolden(name, secret)).toEqual(readFixture(`${name}.output.json`));
    });
  }
});

describe("ga4 v1 integration — page.viewed (1QKDI)", () => {
  const logger = createLogger({ service: "test", version: "v1", env: "test", level: "fatal" });

  it("delivers page.viewed as page_view instead of skipping it as unmapped", async () => {
    const { fetch, calls } = makeFetch(() => new Response(null, { status: 204 }));
    const instance = fixtureDestinationInstance(SECRET);
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);

    const runtime = createDestinationConsumer({
      descriptor: createGa4Descriptor({ fetch, requestTimeoutMs: 5000 }),
      consumer: {} as never,
      producer: NOOP_PRODUCER,
      instances,
      records: new InMemoryDeliveryRecordRepository(),
      logger,
    });
    const record = await runtime.handleEvent({
      envelope: fixtureEnvelope({
        event_id: "evt_int_ga4_page",
        event: "page.viewed",
        properties: {},
      }),
      destination_id: instance.destination_id,
    });

    expect(record?.status).toBe("accepted");
    const body = JSON.parse(calls[0]?.body ?? "");
    expect(body.events[0].name).toBe("page_view");
    expect(body.events[0].params.page_location).toBe("https://storefront.example/checkout");
    expect(body.events[0].params.engagement_time_msec).toBe(1);
  });
});
