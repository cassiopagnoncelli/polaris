/**
 * Golden tests for the braze v1 consumer.
 *
 * Each `test/fixtures/<case>.input.json` is a canonical envelope and each
 * `<case>.output.json` is the exact body Braze receives for it. The pair is
 * driven through the PRODUCTION path — `createDestinationConsumer(...)
 * .handleEvent(...)` with the real descriptor — so the recorded body is
 * what normalize, map and deliver actually produce together, not what a
 * mapper produces from a hand-built normalized event.
 *
 * That distinction is why this file exists (STHB0). The fixtures were
 * written with the consumer and then executed by nothing, so they recorded
 * a claim about the wire body that no failure could contradict. Every
 * question the goldens are supposed to answer — does the trait snapshot
 * reach the attribute object, does the geo default hold — is a question
 * about the whole pipeline, and `mapper.test.ts` answers it one stage
 * short.
 *
 * `user-identified-traits` is the case the S0 repairs turned on:
 *
 *   - `properties` carries a project trait and NO email, so the raw
 *     `email` on the attribute object can only have come from the profile
 *     snapshot through `matchKeysFromTraits` (1VEL3). Braze declares
 *     `identityHashing: { email: false, phone: false }`, so the value
 *     arrives in the clear, which is what its REST API consumes.
 *   - the profile's own `address` outranks the geo block beside it, and
 *     the instance has not opted into `location_from_geo` anyway — the
 *     envelope carries a Lisbon lookup and the profile says Menlo Park,
 *     and the golden records Menlo Park.
 *   - `internal_risk_score` is in the snapshot and not in the body. The
 *     allowlist is the whole point of the trait path.
 *
 * `app-source-purchase`'s IDFV changed with this file, and the reason is
 * the second thing running the goldens found. It was
 * `11111111-2222-3333-4444-555555555555`, which is not a UUID any device
 * issues and whose digits contain a Luhn-valid nineteen-digit run — so the
 * normalizer's second-pass redaction replaced it with `[REDACTED:pii_card]`
 * and Braze received no device id at all. The golden claimed otherwise for
 * as long as nothing executed it. The value is now hex, like a real IDFV,
 * and the recorded body is the one the pipeline produces. The same
 * placeholder is in meta-capi's, tiktok's and ga4's fixtures, where no
 * golden test runs yet.
 *
 * @see connectors/destinations/braze/v1/src/mapper.ts
 * @see sync/destinations/braze/v1/SPEC.md
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PolarisProducer } from "@polaris/bus";
import type { NormalizableEnvelope } from "@polaris/delivery-normalize";
import {
  createDestinationConsumer,
  InMemoryDeliveryRecordRepository,
  InMemoryDestinationInstanceReader,
} from "@polaris/delivery-destinations";
import { createLogger } from "@polaris/observability-logger";
import { describe, expect, it } from "vitest";

import { createBrazeDescriptor } from "../src/connector.js";
import { fixtureDestinationInstance } from "./fixtures/normalized.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

const CASES = readdirSync(FIXTURES)
  .filter((name) => name.endsWith(".input.json"))
  .map((name) => name.slice(0, -".input.json".length))
  .sort();

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

const SECRET = JSON.stringify({ instance: "iad-01", api_key: "br-test-api-key-xyz123456" });

const NOOP_PRODUCER = {
  connect: async () => undefined,
  disconnect: async () => undefined,
  isConnected: () => true,
  publish: async () => ({ stream: "analytics.events-0", partition: 0 }),
  publishEvent: async () => ({ stream: "analytics.events-0", partition: 0 }),
  publishToQueue: async () => undefined,
} as unknown as PolarisProducer;

const logger = createLogger({ service: "test", version: "v1", env: "test", level: "fatal" });

/** Drive one envelope through the consumer and return the POSTed body. */
async function deliver(envelope: NormalizableEnvelope): Promise<unknown> {
  const bodies: string[] = [];
  const instance = fixtureDestinationInstance(SECRET);
  const instances = new InMemoryDestinationInstanceReader();
  instances.set(instance);

  const descriptor = createBrazeDescriptor({
    fetch: async (_input, init) => {
      bodies.push(typeof init?.body === "string" ? init.body : String(init?.body ?? ""));
      return new Response('{"message":"success"}', { status: 200 });
    },
    requestTimeoutMs: 5000,
  });
  const runtime = createDestinationConsumer({
    descriptor,
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
  expect(record?.status, `${envelope.event} was not accepted`).toBe("accepted");
  expect(bodies).toHaveLength(1);
  return JSON.parse(bodies[0] ?? "");
}

describe("braze v1 goldens", () => {
  it("finds every recorded pair", () => {
    // Guards the guard: an empty list makes the `it.each` below vacuous and
    // the suite reports green having compared nothing.
    expect(CASES).toEqual(["app-source-purchase", "checkout-started", "user-identified-traits"]);
  });

  it.each(CASES)("%s: the wire body is what the golden records", async (name) => {
    const envelope = readJson(join(FIXTURES, `${name}.input.json`)) as NormalizableEnvelope;
    expect(await deliver(envelope)).toEqual(readJson(join(FIXTURES, `${name}.output.json`)));
  });
});
