/**
 * The `page-viewed` golden pair, pinned to what the pipeline emits.
 *
 * The other goldens in `test/fixtures/` are illustrative: their hashes are
 * placeholders showing where a field sits, and nothing executes them. That
 * is how four of them carried an `event_time` two days off their own
 * `occurred_at` — a copy-paste from a fixture written on a different date,
 * which no test could contradict because no test read them (V87AS).
 *
 * This pair is different in kind, which is why it is the one under test.
 * Its digests are real, and it exists to document PROVENANCE — that
 * `external_id` is the digest of the profile's `canonical_customer_id`
 * rather than of the `customer_id` the same envelope carries, and that
 * `user.email` / `user.phone` come from the profile-trait snapshot. A
 * claim about where a value came from is worth nothing if the golden
 * stating it can drift from the code, so it does not.
 *
 * The input is fed to `createDestinationConsumer` — the same production
 * path `integration.test.ts` drives — so the assertion covers normalize
 * and the mapper together, not the mapper alone.
 */

import { readFileSync } from "node:fs";

import {
  createDestinationConsumer,
  InMemoryDeliveryRecordRepository,
  InMemoryDestinationInstanceReader,
} from "@polaris/delivery-destinations";
import { createLogger } from "@polaris/observability-logger";
import type { PolarisProducer } from "@polaris/bus";
import { describe, expect, it } from "vitest";

import { createTikTokDescriptor } from "../src/connector.js";
import { fixtureDestinationInstance } from "./fixtures/normalized.js";

const NOOP_PRODUCER = {
  connect: async () => undefined,
  disconnect: async () => undefined,
  isConnected: () => true,
  publish: async () => ({ stream: "analytics.events-0", partition: 0 }),
  publishEvent: async () => ({ stream: "analytics.events-0", partition: 0 }),
  publishToQueue: async () => undefined,
} as unknown as PolarisProducer;

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

describe("page-viewed golden", () => {
  it("is the payload the pipeline actually produces", async () => {
    const input = readFixture("page-viewed.input.json");
    const expected = readFixture("page-viewed.output.json");

    let body = "";
    const fetch = (async (_input: unknown, init?: { body?: unknown }) => {
      body = typeof init?.body === "string" ? init.body : "";
      return new Response('{"code":0,"message":"OK","request_id":"req_golden"}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const instance = fixtureDestinationInstance(
      JSON.stringify({ access_token: "TT-test-token", pixel_id: "C9876543210" }),
    );
    const instances = new InMemoryDestinationInstanceReader();
    instances.set(instance);

    const runtime = createDestinationConsumer({
      descriptor: createTikTokDescriptor({ fetch, requestTimeoutMs: 5000 }),
      consumer: {} as never,
      producer: NOOP_PRODUCER,
      instances,
      records: new InMemoryDeliveryRecordRepository(),
      logger: createLogger({ service: "test", version: "v1", env: "test", level: "fatal" }),
    });

    const record = await runtime.handleEvent({
      envelope: input as never,
      destination_id: instance.destination_id,
    });

    expect(record?.status).toBe("accepted");
    expect(JSON.parse(body).data[0]).toEqual(expected);
  });
});
