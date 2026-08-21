/**
 * App-level integration test for the tiktok v1 consumer.
 *
 * Drives `createDestinationConsumer({...}).handleEvent({...})` with the
 * tiktok descriptor and in-memory adapters so the full pipeline runs
 * end-to-end without a RabbitMQ broker or PostgreSQL:
 *
 *   envelope → normalize → map (per-event) → deliver (fake fetch)
 *           → RECORD (in-memory delivery_records [+ dlq_records on
 *             permanent / threshold-retryable])
 *
 * @see docs/architecture/06-destinations.md "Destination Consumer"
 */

import type { NormalizableEnvelope } from "@polaris/delivery-normalize";
import { hashEmailLower, hashPhoneE164, sha256Hex } from "@polaris/delivery-normalize";
import {
  createDestinationConsumer,
  InMemoryDeliveryRecordRepository,
  InMemoryDestinationInstanceReader,
  InMemoryDlqRecordRepository,
} from "@polaris/delivery-destinations";
import { createLogger } from "@polaris/observability-logger";
import type { PolarisProducer } from "@polaris/bus";
import { describe, expect, it } from "vitest";

import { createTikTokDescriptor } from "../src/connector.js";
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
    event_id: "evt_int_tiktok_001",
    event: "checkout.started",
    schema_version: 1,
    project_id: "storefront",
    environment: "production",
    occurred_at: "2026-05-14T12:00:00.000Z",
    ingested_at: "2026-05-14T12:00:00.500Z",
    source: { id: "storefront-web", type: "frontend" },
    identity: {
      customer_id: "cust_int_tiktok",
      anonymous_id: "anon_int_tiktok",
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
  access_token: "TT-test-token",
  pixel_id: "C9876543210",
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tiktok v1 integration (handleEvent driven)", () => {
  const logger = createLogger({
    service: "test",
    version: "v1",
    env: "test",
    level: "fatal",
  });

  it("delivers a checkout.started event and writes status=accepted", async () => {
    const { fetch, calls } = makeFetch(
      () => new Response('{"code":0,"message":"OK","request_id":"req_abc"}', { status: 200 }),
    );

    const instance = fixtureDestinationInstance(SECRET);
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();

    const descriptor = createTikTokDescriptor({
      fetch,
      requestTimeoutMs: 5000,
      apiHost: "business-api.tiktok.test",
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
    // Vendor dedupe_key stamped on the record IS the canonical event_id.
    expect(record?.dedupe_key).toBe("evt_int_tiktok_001");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/open_api/v1.3/event/track/");
    expect(calls[0]?.headers["access-token"]).toBe("TT-test-token");
    const body = JSON.parse(calls[0]?.body ?? "");
    expect(body.event_source).toBe("web");
    expect(body.event_source_id).toBe("C9876543210");
    expect(body.data[0].event).toBe("InitiateCheckout");
    expect(body.data[0].event_id).toBe("evt_int_tiktok_001");
  });

  it("drops events when required marketing consent is denied", async () => {
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const instance = fixtureDestinationInstance(SECRET);
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();

    const descriptor = createTikTokDescriptor({ fetch, requestTimeoutMs: 5000 });
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

    const descriptor = createTikTokDescriptor({ fetch, requestTimeoutMs: 5000 });
    const runtime = createDestinationConsumer({
      descriptor,
      consumer: {} as never,
      producer: NOOP_PRODUCER,
      instances,
      records,
      logger,
    });

    // `session.started` stands in for the unmapped case. It used to be
    // `page.viewed`, which V87AS mapped — an unmapped-event test has to
    // name an event the matrix genuinely omits, or it passes for the
    // wrong reason the day somebody maps it.
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
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const instance = fixtureDestinationInstance(SECRET);
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();

    const descriptor = createTikTokDescriptor({ fetch, requestTimeoutMs: 5000 });
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
      () => new Response('{"code":0,"message":"OK","request_id":"req_signup"}', { status: 200 }),
    );
    const instance = fixtureDestinationInstance(SECRET);
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();

    const descriptor = createTikTokDescriptor({ fetch, requestTimeoutMs: 5000 });
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
        event_id: "evt_int_tiktok_signup",
        event: "signup.completed",
        properties: { currency: "USD" },
      }),
      destination_id: instance.destination_id,
    });

    expect(record?.status).toBe("accepted");
    const body = JSON.parse(calls[0]?.body ?? "");
    expect(body.data[0].event).toBe("CompleteRegistration");
    expect(body.data[0].properties).toEqual({ currency: "USD" });
  });

  it("delivers a subscription.renewed event as Subscribe with value + subscription order_id", async () => {
    const { fetch, calls } = makeFetch(
      () => new Response('{"code":0,"message":"OK","request_id":"req_sub"}', { status: 200 }),
    );
    const instance = fixtureDestinationInstance(SECRET);
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();

    const descriptor = createTikTokDescriptor({ fetch, requestTimeoutMs: 5000 });
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
        event_id: "evt_int_tiktok_sub",
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
    const body = JSON.parse(calls[0]?.body ?? "");
    expect(body.data[0].event).toBe("Subscribe");
    expect(body.data[0].properties).toEqual({
      currency: "USD",
      value: 19.99,
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

    const descriptor = createTikTokDescriptor({ fetch, requestTimeoutMs: 5000 });
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
    expect(dlq[0]?.vendor).toBe("tiktok");
  });

  it("delivers a page.viewed event as Pageview with the page url and referrer", async () => {
    const { fetch, calls } = makeFetch(
      () => new Response('{"code":0,"message":"OK","request_id":"req_view"}', { status: 200 }),
    );
    const instance = fixtureDestinationInstance(SECRET);
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();

    const descriptor = createTikTokDescriptor({ fetch, requestTimeoutMs: 5000 });
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
        event_id: "evt_int_tiktok_view",
        event: "page.viewed",
        context: {
          ip: "203.0.113.42",
          user_agent: "Mozilla/5.0",
          page: {
            url: "https://storefront.example/products/widget",
            referrer: "https://search.example/?q=widget",
          },
        },
        properties: { path: "/products/widget", search: null, title: "Widget", referrer: null },
      }),
      destination_id: instance.destination_id,
    });

    expect(record?.status).toBe("accepted");
    const body = JSON.parse(calls[0]?.body ?? "");
    expect(body.data[0].event).toBe("Pageview");
    expect(body.data[0].page).toEqual({
      url: "https://storefront.example/products/widget",
      referrer: "https://search.example/?q=widget",
    });
    // A view carries no commerce properties, and the canonical ones have
    // no TikTok counterpart this version reads.
    expect(body.data[0].properties).toBeUndefined();
    // `event_source` is inferred exactly as it is for every other event.
    expect(body.event_source).toBe("web");
  });

  it("still denies a page.viewed event without marketing consent", async () => {
    // The new mapping widens what TikTok hears about, not who may send
    // it. The gate is the descriptor's, so this proves the new event did
    // not arrive with an exemption.
    const { fetch, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const instance = fixtureDestinationInstance(SECRET);
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();

    const descriptor = createTikTokDescriptor({ fetch, requestTimeoutMs: 5000 });
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
        event: "page.viewed",
        consent: { marketing: false, analytics: true, personalization: true },
      }),
      destination_id: instance.destination_id,
    });

    expect(record?.status).toBe("dropped_consent");
    expect(calls).toHaveLength(0);
  });

  it("sends hashed email and phone from the profile-trait snapshot (1VEL3)", async () => {
    // The production-path proof. The mapper goldens start from an already
    // prepared `NormalizedEvent`, so they assert that `user.email` carries
    // `identity.email_sha256` and never ask where that value came from —
    // which is exactly how the gap 1VEL3 fixed went unnoticed. This test
    // starts at the envelope and runs the real normalize stage, so it
    // fails if identity preparation stops reading the trait snapshot.
    const { fetch, calls } = makeFetch(
      () => new Response('{"code":0,"message":"OK","request_id":"req_traits"}', { status: 200 }),
    );
    const instance = fixtureDestinationInstance(SECRET);
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();

    const descriptor = createTikTokDescriptor({ fetch, requestTimeoutMs: 5000 });
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
        event_id: "evt_int_tiktok_traits",
        profile: {
          profile_id: "01930000-0000-7000-8000-0000000000aa",
          canonical_customer_id: "cus_canonical",
          traits: { email: "Someone@Example.com", phone: "+14155550123", tier: "gold" },
          traits_version: 7,
        },
      }),
      destination_id: instance.destination_id,
    });

    expect(record?.status).toBe("accepted");
    const user = JSON.parse(calls[0]?.body ?? "").data[0].user;
    expect(user.email).toBe(hashEmailLower("Someone@Example.com"));
    expect(user.phone).toBe(hashPhoneE164("+14155550123"));
    // Neither plaintext reaches the vendor beside its digest.
    expect(JSON.stringify(user)).not.toContain("Someone@Example.com");
    expect(JSON.stringify(user)).not.toContain("+14155550123");
  });

  it("keys external_id on the resolved customer id, not the producer's", async () => {
    // Two producers spelling one customer differently used to land as two
    // TikTok users. The envelope below carries both spellings; only the
    // platform's resolution should reach the wire.
    const { fetch, calls } = makeFetch(
      () => new Response('{"code":0,"message":"OK","request_id":"req_ext"}', { status: 200 }),
    );
    const instance = fixtureDestinationInstance(SECRET);
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();

    const descriptor = createTikTokDescriptor({ fetch, requestTimeoutMs: 5000 });
    const runtime = createDestinationConsumer({
      descriptor,
      consumer: {} as never,
      producer: NOOP_PRODUCER,
      instances,
      records,
      logger,
    });

    const resolved = await runtime.handleEvent({
      envelope: fixtureEnvelope({
        event_id: "evt_int_tiktok_ext_resolved",
        identity: { customer_id: "storefront-42", anonymous_id: "anon_int_tiktok" },
        profile: {
          profile_id: "01930000-0000-7000-8000-0000000000aa",
          canonical_customer_id: "cus_canonical",
        },
      }),
      destination_id: instance.destination_id,
    });

    expect(resolved?.status).toBe("accepted");
    expect(JSON.parse(calls[0]?.body ?? "").data[0].user.external_id).toBe(
      sha256Hex("cus_canonical"),
    );

    // And the unresolved envelope — no profile block at all — is unchanged.
    const unresolved = await runtime.handleEvent({
      envelope: fixtureEnvelope({
        event_id: "evt_int_tiktok_ext_unresolved",
        identity: { customer_id: "storefront-42", anonymous_id: "anon_int_tiktok" },
      }),
      destination_id: instance.destination_id,
    });

    expect(unresolved?.status).toBe("accepted");
    expect(JSON.parse(calls[1]?.body ?? "").data[0].user.external_id).toBe(
      sha256Hex("storefront-42"),
    );
  });
});
