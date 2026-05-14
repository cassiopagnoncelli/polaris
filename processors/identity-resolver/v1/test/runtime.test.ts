/**
 * Streaming runtime tests for identity-resolver v1 (P8-002b).
 *
 * Each test:
 *
 *   1. Builds an `InMemoryIdentityLinkRepository`.
 *   2. Builds a `RecordingProducer` (publishEvent captures publishes).
 *   3. Builds a stub `PolarisConsumer` (the runtime only calls
 *      .subscribe / .runEach / .disconnect on it).
 *   4. Calls `createRuntime({...}).handler(payload, context)` directly.
 *   5. Asserts on the recorded publishes + repository state.
 *
 * This is the same approach `analytics-projector/v1/test/runtime.test.ts`
 * uses — drive the handler directly, never spin up real KafkaJS.
 *
 * @see docs/implementation/tasks/P8-002b-identity-resolver-behavioral-tests.md
 */

import type { EachMessagePayload } from "kafkajs";
import { describe, expect, it } from "vitest";

import {
  type PolarisConsumer,
  type PolarisMessageContext,
  type PolarisProducer,
  type PublishEventInput,
  TOPIC_FAMILY_IDENTITY_EVENTS,
} from "@polaris/shared-kafka";
import type { Logger } from "@polaris/shared-logger";

import { InMemoryIdentityLinkRepository } from "../src/repository.js";
import { createRuntime } from "../src/runtime.js";
import { PROCESSOR_NAME, PROCESSOR_VERSION } from "../src/transform.js";

const noopLogger: Logger = {
  fatal: () => {},
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => noopLogger,
} as unknown as Logger;

function makeRawEnvelope(overrides: {
  event_id?: string;
  event?: string;
  identity?: {
    anonymous_id?: string | null;
    session_id?: string | null;
    customer_id?: string | null;
    device_id?: string | null;
  };
}): Record<string, unknown> {
  return {
    event_id: overrides.event_id ?? "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
    event: overrides.event ?? "user.signed_in",
    schema_version: 1,
    project_id: "storefront",
    environment: "production",
    occurred_at: "2026-05-12T12:00:00.000Z",
    ingested_at: "2026-05-12T12:00:00.250Z",
    source: { type: "web", id: "storefront-web" },
    identity: {
      anonymous_id: overrides.identity?.anonymous_id ?? null,
      session_id: overrides.identity?.session_id ?? null,
      customer_id: overrides.identity?.customer_id ?? null,
      device_id: overrides.identity?.device_id ?? null,
    },
    context: {},
    properties: {},
  };
}

function makePayload(envelope: unknown): EachMessagePayload {
  return {
    topic: "raw.events",
    partition: 0,
    message: {
      key: null,
      value: Buffer.from(JSON.stringify(envelope), "utf8"),
      headers: {},
      offset: "0",
      timestamp: "1715515200000",
      size: 0,
      attributes: 0,
    },
    heartbeat: async () => {},
    pause: () => () => {},
  } as unknown as EachMessagePayload;
}

const CONTEXT: PolarisMessageContext = {
  event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
  project_id: "storefront",
  environment: "production",
  request_id: "req_test",
};

interface CapturedPublish {
  family: string;
  event: Record<string, unknown>;
  partitionKey: string | undefined;
}

class RecordingProducer {
  public readonly publishes: CapturedPublish[] = [];

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async publishEvent(input: PublishEventInput): Promise<void> {
    this.publishes.push({
      family: input.family,
      event: input.event as Record<string, unknown>,
      partitionKey: input.partitionKey,
    });
  }
}

function makeConsumer(): PolarisConsumer {
  return {
    subscribe: async () => {},
    runEach: async () => {},
    disconnect: async () => {},
  } as unknown as PolarisConsumer;
}

interface BuiltRuntimeEnv {
  repo: InMemoryIdentityLinkRepository;
  producer: RecordingProducer;
  runtime: ReturnType<typeof createRuntime>;
}

let eventIdCounter = 0;
function nextEventId(): string {
  eventIdCounter += 1;
  return `018f1b9e-7b50-7b12-aaaa-${String(eventIdCounter).padStart(12, "0")}`;
}

function buildEnv(): BuiltRuntimeEnv {
  const repo = new InMemoryIdentityLinkRepository({
    now: () => new Date("2026-05-12T12:00:00.500Z"),
    newId: (() => {
      let i = 0;
      return () => {
        i += 1;
        return `lnk_test_${String(i).padStart(4, "0")}`;
      };
    })(),
  });
  const producer = new RecordingProducer();
  const runtime = createRuntime({
    consumer: makeConsumer(),
    producer: producer as unknown as PolarisProducer,
    repository: repo,
    logger: noopLogger,
    now: () => new Date("2026-05-12T12:00:00.500Z"),
    newEventId: nextEventId,
    run_id: "run_test_1",
  });
  return { repo, producer, runtime };
}

describe("identity-resolver runtime — happy paths", () => {
  it("emits identity.linked on a first (customer_id, anonymous_id) co-occurrence", async () => {
    const { repo, producer, runtime } = buildEnv();
    const envelope = makeRawEnvelope({
      identity: { customer_id: "cus_1", anonymous_id: "anon-1" },
    });
    await runtime.handler(makePayload(envelope), CONTEXT);

    expect(producer.publishes).toHaveLength(1);
    const pub = producer.publishes[0];
    expect(pub?.family).toBe(TOPIC_FAMILY_IDENTITY_EVENTS);
    const event = pub?.event as Record<string, unknown>;
    expect(event["event"]).toBe("identity.linked");
    expect(event["processor_name"]).toBe(PROCESSOR_NAME);
    expect(event["processor_version"]).toBe(PROCESSOR_VERSION);

    // A new row should be in the repository.
    const active = await repo.findActive({
      project_id: "storefront",
      environment: "production",
      identifier: "anonymous_id:anon-1",
    });
    expect(active).toHaveLength(1);
  });

  it("emits identity.merged when an anonymous_id rebinds to a different customer_id", async () => {
    const { repo, producer, runtime } = buildEnv();

    // First, link (customer_id:cus_OLD, anonymous_id:anon-1).
    await runtime.handler(
      makePayload(
        makeRawEnvelope({
          event_id: "018f1b9e-7b50-7b12-9a2e-000000000001",
          identity: { customer_id: "cus_OLD", anonymous_id: "anon-1" },
        }),
      ),
      CONTEXT,
    );
    expect(producer.publishes).toHaveLength(1);
    expect((producer.publishes[0]?.event as Record<string, unknown>)["event"]).toBe(
      "identity.linked",
    );

    // Then anonymous_id:anon-1 turns up with customer_id:cus_NEW.
    await runtime.handler(
      makePayload(
        makeRawEnvelope({
          event_id: "018f1b9e-7b50-7b12-9a2e-000000000002",
          identity: { customer_id: "cus_NEW", anonymous_id: "anon-1" },
        }),
      ),
      CONTEXT,
    );
    expect(producer.publishes.length).toBeGreaterThanOrEqual(2);
    const second = producer.publishes[1]?.event as Record<string, unknown>;
    expect(second["event"]).toBe("identity.merged");
    const props = second["properties"] as Record<string, unknown>;
    expect(props["shared_identifier"]).toBe("anonymous_id:anon-1");

    // The OLD row should now be superseded.
    const stillActive = await repo.findActive({
      project_id: "storefront",
      environment: "production",
      identifier: "anonymous_id:anon-1",
    });
    expect(stillActive).toHaveLength(1);
    expect(stillActive[0]?.right_identifier).toBe("customer_id:cus_NEW");
  });

  it("emits identity.rotated when an anonymous_id rotates under a stable customer_id", async () => {
    const { producer, runtime } = buildEnv();

    // First binding: (customer_id:cus_1, anonymous_id:anon-OLD).
    await runtime.handler(
      makePayload(
        makeRawEnvelope({
          event_id: "018f1b9e-7b50-7b12-9a2e-000000000003",
          identity: { customer_id: "cus_1", anonymous_id: "anon-OLD" },
        }),
      ),
      CONTEXT,
    );

    // Second binding: same customer, new anonymous (rotation).
    await runtime.handler(
      makePayload(
        makeRawEnvelope({
          event_id: "018f1b9e-7b50-7b12-9a2e-000000000004",
          identity: { customer_id: "cus_1", anonymous_id: "anon-NEW" },
        }),
      ),
      CONTEXT,
    );
    const second = producer.publishes[1]?.event as Record<string, unknown>;
    expect(second["event"]).toBe("identity.rotated");
    const props = second["properties"] as Record<string, unknown>;
    expect(props["stable_identifier"]).toBe("customer_id:cus_1");
    expect(props["new_identifier"]).toBe("anonymous_id:anon-NEW");
    expect(props["previous_identifier"]).toBe("anonymous_id:anon-OLD");
  });
});

describe("identity-resolver runtime — short-circuit paths", () => {
  it("does NOT publish when the envelope has no strong identifier overlap", async () => {
    const { producer, runtime } = buildEnv();
    // Only session_id — no strong identifiers.
    await runtime.handler(
      makePayload(
        makeRawEnvelope({
          identity: { session_id: "sess-only" },
        }),
      ),
      CONTEXT,
    );
    expect(producer.publishes).toHaveLength(0);
  });

  it("does NOT publish when only one strong identifier is present", async () => {
    const { producer, runtime } = buildEnv();
    await runtime.handler(
      makePayload(
        makeRawEnvelope({
          identity: { customer_id: "cus_lonely" },
        }),
      ),
      CONTEXT,
    );
    expect(producer.publishes).toHaveLength(0);
  });

  it("re-emits identity.linked (idempotent) when the exact (left, right) pair is replayed", async () => {
    const { repo, producer, runtime } = buildEnv();
    const envelope = makeRawEnvelope({
      identity: { customer_id: "cus_R", anonymous_id: "anon-R" },
    });
    await runtime.handler(makePayload(envelope), CONTEXT);
    await runtime.handler(makePayload(envelope), CONTEXT);

    // Both publishes should be identity.linked; the second is the
    // idempotent emission (the runtime publishes the canonical event
    // for traceability but does NOT insert a duplicate row).
    expect(producer.publishes).toHaveLength(2);
    expect((producer.publishes[0]?.event as Record<string, unknown>)["event"]).toBe(
      "identity.linked",
    );
    expect((producer.publishes[1]?.event as Record<string, unknown>)["event"]).toBe(
      "identity.linked",
    );

    // Only ONE active row in the repo — replay didn't double-insert.
    const active = await repo.findActive({
      project_id: "storefront",
      environment: "production",
      identifier: "anonymous_id:anon-R",
    });
    expect(active).toHaveLength(1);
  });
});

describe("identity-resolver runtime — error paths", () => {
  it("throws on malformed payload (non-JSON bytes) so KafkaJS surfaces the failure", async () => {
    const { runtime } = buildEnv();
    const badPayload = {
      ...makePayload(""),
      message: {
        key: null,
        value: Buffer.from("this-is-not-json", "utf8"),
        headers: {},
        offset: "0",
        timestamp: "0",
        size: 0,
        attributes: 0,
      },
    } as unknown as EachMessagePayload;
    await expect(runtime.handler(badPayload, CONTEXT)).rejects.toThrow();
  });

  it("throws when the decoded payload is missing required envelope fields", async () => {
    const { runtime } = buildEnv();
    // Decodable JSON but not an envelope — missing event_id, etc.
    const partial = {
      topic: "raw.events",
      partition: 0,
      message: {
        key: null,
        value: Buffer.from(JSON.stringify({ event: "user.signed_in" }), "utf8"),
        headers: {},
        offset: "0",
        timestamp: "0",
        size: 0,
        attributes: 0,
      },
      heartbeat: async () => {},
      pause: () => () => {},
    } as unknown as EachMessagePayload;
    await expect(runtime.handler(partial, CONTEXT)).rejects.toThrow();
  });

  it("skips tombstone (empty value) messages without throwing", async () => {
    const { producer, runtime } = buildEnv();
    const tombstone = {
      topic: "raw.events",
      partition: 0,
      message: {
        key: null,
        value: null,
        headers: {},
        offset: "0",
        timestamp: "0",
        size: 0,
        attributes: 0,
      },
      heartbeat: async () => {},
      pause: () => () => {},
    } as unknown as EachMessagePayload;
    await expect(runtime.handler(tombstone, CONTEXT)).resolves.toBeUndefined();
    expect(producer.publishes).toHaveLength(0);
  });
});

describe("identity-resolver runtime — metrics", () => {
  it("increments the consumed metric on every well-formed envelope", async () => {
    const { runtime } = buildEnv();
    await runtime.handler(
      makePayload(
        makeRawEnvelope({
          identity: { customer_id: "cus_M", anonymous_id: "anon-M" },
        }),
      ),
      CONTEXT,
    );
    await runtime.handler(
      makePayload(
        makeRawEnvelope({
          event_id: "018f1b9e-7b50-7b12-9a2e-000000000099",
          identity: { customer_id: "cus_M2", anonymous_id: "anon-M2" },
        }),
      ),
      CONTEXT,
    );
    const samples = runtime.metrics.getSamples();
    const consumed = samples.find((s) => s.name === "polaris_processor_events_consumed_total");
    expect(consumed?.value).toBeGreaterThanOrEqual(2);
  });
});
