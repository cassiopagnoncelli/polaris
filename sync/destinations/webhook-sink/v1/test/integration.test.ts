/**
 * App-level integration test for the webhook-sink v1 consumer.
 *
 * Drives `createDestinationConsumer({...}).handleEvent({...})` with the
 * webhook-sink descriptor and in-memory adapters so the full pipeline
 * runs end-to-end without a RabbitMQ broker or PostgreSQL:
 *
 *   envelope -> normalize -> map (passthrough) -> deliver (fake fetch)
 *            -> RECORD (in-memory delivery_records)
 *
 * This pins the consumer's contract with the shared runtime — if the
 * runtime contract changes, this test surfaces the break before any
 * vendor consumer ships.
 *
 * @see docs/architecture/06-destinations.md "Destination Consumer"
 */

import type { NormalizableEnvelope } from "@polaris/shared-destination-normalize";
import {
  createDestinationConsumer,
  InMemoryDeliveryRecordRepository,
  InMemoryDestinationInstanceReader,
} from "@polaris/shared-destinations";
import { createLogger } from "@polaris/shared-logger";
import type { PolarisProducer } from "@polaris/shared-transport";
import { describe, expect, it } from "vitest";

import { createWebhookSinkDescriptor } from "../src/descriptor.js";
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
      const hraw = init?.headers ?? {};
      if (hraw instanceof Headers) {
        hraw.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
      } else if (Array.isArray(hraw)) {
        for (const [k, v] of hraw) headers[String(k).toLowerCase()] = String(v);
      } else {
        for (const [k, v] of Object.entries(hraw)) headers[String(k).toLowerCase()] = String(v);
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

function fixtureEnvelope(): NormalizableEnvelope {
  return {
    event_id: "evt_int_test_001",
    event: "payment.approved",
    schema_version: 1,
    project_id: "storefront",
    environment: "production",
    occurred_at: "2026-05-14T12:00:00.000Z",
    ingested_at: "2026-05-14T12:00:00.500Z",
    source: { type: "node-sdk", version: "1.0.0" },
    identity: {
      customer_id: "cust_int_test",
      anonymous_id: "anon_int",
    },
    context: null,
    properties: { amount_cents: 1995, currency: "USD" },
    consent: null,
    privacy: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("webhook-sink v1 integration (handleEvent driven)", () => {
  // Silence runtime logs in the test transcript. Pino emits structured
  // info/error lines on every delivery; vitest's default reporter prints
  // them inline and drowns the assertions. `fatal` suppresses everything
  // below the highest severity.
  const logger = createLogger({
    service: "test",
    version: "v1",
    env: "test",
    level: "fatal",
  });

  it("delivers a happy-path envelope and writes a single 'accepted' delivery record", async () => {
    const { fetch, calls } = makeFetch(() => new Response("ok", { status: 200 }));

    const instance = fixtureDestinationInstance("https://hooks.example/receiver");
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);

    const records = new InMemoryDeliveryRecordRepository();

    const descriptor = createWebhookSinkDescriptor({
      fetch,
      requestTimeoutMs: 5000,
      now: () => new Date("2026-05-14T12:00:00.000Z"),
    });

    const runtime = createDestinationConsumer({
      descriptor,
      consumer: {} as never,
      producer: NOOP_PRODUCER,
      instances,
      records,
      logger,
      now: () => new Date("2026-05-14T12:00:00.000Z"),
    });

    const record = await runtime.handleEvent({
      envelope: fixtureEnvelope(),
      destination_id: instance.destination_id,
    });

    expect(record).not.toBeNull();
    expect(record?.status).toBe("accepted");
    expect(record?.consumer_version).toBe("v1");
    expect(record?.mapper_version).toBe("v1");
    expect(record?.deliverer_version).toBe("v1");
    expect(record?.normalize_version).toBe("v2");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://hooks.example/receiver");

    const body = JSON.parse(calls[0]?.body ?? "");
    expect(body.version).toBe(1);
    expect(body.event.event).toBe("payment.approved");
    expect(body.event.event_id).toBe("evt_int_test_001");
    expect(body.delivery.consumer.vendor).toBe("webhook");
    expect(body.delivery.attempt).toBe(1);
    expect(body.delivery.delivery_key).toMatch(/^polaris_del_/);
    expect(body.delivery.sent_at).toBe("2026-05-14T12:00:00.000Z");
  });

  it("maps an HTTP 500 response to a failed_retryable delivery record", async () => {
    const { fetch } = makeFetch(() => new Response("oops", { status: 500 }));

    const instance = fixtureDestinationInstance("https://hooks.example/");
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();

    const descriptor = createWebhookSinkDescriptor({
      fetch,
      requestTimeoutMs: 5000,
      now: () => new Date("2026-05-14T12:00:00.000Z"),
    });

    const runtime = createDestinationConsumer({
      descriptor,
      consumer: {} as never,
      producer: NOOP_PRODUCER,
      instances,
      records,
      logger,
      now: () => new Date("2026-05-14T12:00:00.000Z"),
    });

    // The runtime re-throws on failed_retryable so KafkaJS retries.
    await expect(
      runtime.handleEvent({
        envelope: fixtureEnvelope(),
        destination_id: instance.destination_id,
      }),
    ).rejects.toThrow();

    // ...but the delivery record IS written before the rethrow.
    const written = await records.findRecordsByEventId("evt_int_test_001");
    expect(written).toHaveLength(1);
    expect(written[0]?.status).toBe("failed_retryable");
    expect(written[0]?.error_class).toBe("transient");
    expect(written[0]?.vendor_response_code).toBe("500");
  });

  it("treats a malformed secret value as a permanent auth failure", async () => {
    const { fetch, calls } = makeFetch(() => new Response("never reached", { status: 200 }));

    const instance = fixtureDestinationInstance("this-is-not-a-url");
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();

    const descriptor = createWebhookSinkDescriptor({
      fetch,
      requestTimeoutMs: 5000,
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
    expect(record?.status).toBe("failed_permanent");
    expect(record?.error_class).toBe("auth");
    // The deliverer must short-circuit before calling fetch.
    expect(calls).toHaveLength(0);
  });

  it("signs the request body when the secret is { url, signing_key }", async () => {
    const { fetch, calls } = makeFetch(() => new Response(null, { status: 204 }));

    const instance = fixtureDestinationInstance(
      JSON.stringify({
        url: "https://hooks.example/receiver",
        signing_key: "test_signing_key",
      }),
    );
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();

    const descriptor = createWebhookSinkDescriptor({
      fetch,
      requestTimeoutMs: 5000,
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
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers["x-polaris-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("short-circuits when the destination instance is missing", async () => {
    const { fetch, calls } = makeFetch(() => new Response("", { status: 200 }));
    const instances = new InMemoryDestinationInstanceReader();
    const records = new InMemoryDeliveryRecordRepository();

    const descriptor = createWebhookSinkDescriptor({
      fetch,
      requestTimeoutMs: 5000,
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
      destination_id: "polaris_dst_does_not_exist",
    });
    expect(record).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("records test-mode deliveries without calling fetch", async () => {
    const { fetch, calls } = makeFetch(() => new Response("", { status: 200 }));
    const instance = { ...fixtureDestinationInstance(), mode: "test" as const };
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);
    const records = new InMemoryDeliveryRecordRepository();

    const descriptor = createWebhookSinkDescriptor({
      fetch,
      requestTimeoutMs: 5000,
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
    expect(record?.vendor_response_code).toBe("test_mode");
    // No network call in test mode.
    expect(calls).toHaveLength(0);
  });
});
