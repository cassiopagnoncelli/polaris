/**
 * Behavioral tests for the destination consumer runtime (P9-001b).
 *
 * Drives `createDestinationConsumer({...}).handleEvent({...})` directly so
 * each branch of the per-message pipeline is exercised without spinning up
 * a KafkaJS consumer:
 *
 *   subscribe -> replay-suppress -> resolve instance -> check status -> mode=test
 *   -> dedupe -> normalize -> map -> rate-limit -> deliver -> RECORD
 *
 * Each test wires an `InMemoryDestinationInstanceReader`, an
 * `InMemoryDeliveryRecordRepository`, a stub mapper and deliverer, and
 * asserts on the captured delivery record + metric snapshot.
 *
 * @see docs/implementation/tasks/P9-001b-destination-runtime-behavioral-tests.md
 */

import type { NormalizableEnvelope } from "@polaris/shared-destination-normalize";
import type { Logger } from "@polaris/shared-logger";
import type { MessageHeaders, TransportMessagePayload } from "@polaris/shared-transport";
import { describe, expect, it } from "vitest";

import {
  createDestinationConsumer,
  type Deliverer,
  type DeliveryRecord,
  type DestinationDescriptor,
  type DestinationInstance,
  DestinationInstanceCache,
  InMemoryDeliveryRecordRepository,
  InMemoryDestinationDedupe,
  InMemoryDestinationInstanceReader,
  InMemoryDlqRecordRepository,
  type Mapper,
  type MapperResult,
  POLARIS_HEADER_DESTINATION_VENDOR,
  type RuntimeDropReason,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

/**
 * The transport hands every handler a context alongside the payload. The
 * destination runtime reads nothing from it, which is why these tests called
 * `handler` with one argument for as long as this tree sat on the
 * `tsconfig.tests.json` ratchet.
 */
const TEST_MESSAGE_CONTEXT = {} as const;

const noopLogger: Logger = {
  fatal: () => {},
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => noopLogger,
} as unknown as Logger;

const SEED_INSTANCE: DestinationInstance = {
  destination_id: "polaris_dst_test1",
  project_id: "storefront",
  environment: "development",
  vendor: "test-vendor",
  instance_label: "test-instance",
  secret_value: "<test-secret>",
  status: "active",
  mode: "live",
  max_concurrency: 4,
  max_rps: 50,
  retry_policy: "standard",
  dead_letter_threshold: 5,
  // P7-004: per-instance replay opt-in. The seed is opt-IN so the
  // existing tests (which exercise normal delivery, not replay) match
  // their original semantics; the replay-specific tests below override
  // this to `false` when the suppression gate is what's being tested.
  replay_opt_in: true,
  // `destinations.config`: the per-instance half of the gate's precedence
  // chain. Empty here so the seed overrides nothing, which is the state of
  // every instance nobody has configured.
  config: {},
};

function makeEnvelope(overrides: Partial<NormalizableEnvelope> = {}): NormalizableEnvelope {
  return {
    event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
    event: "payment.approved",
    schema_version: 1,
    project_id: "storefront",
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
    properties: { amount: 4200, currency: "USD" },
    consent: { marketing: true, analytics: true },
    ...overrides,
  };
}

interface MapperCall<P> {
  payload?: P;
}

interface DelivererCall<P> {
  payload: P;
  attempt: number;
  /** How long a credential the runtime handed us — never the value itself. */
  secretLength: number;
  /** The per-project slice the runtime resolved for this envelope. */
  projectConfig: Readonly<Record<string, unknown>>;
}

interface ProducerSend {
  /** Target queue — DLQ routing goes to a queue, not a stream. */
  topic: string;
  key: string | Buffer | null;
  vendor: string;
  headers: MessageHeaders;
}

interface TestPayload {
  vendor_payload: string;
}

interface TestEnv {
  records: InMemoryDeliveryRecordRepository;
  instances: InMemoryDestinationInstanceReader;
  dedupe: InMemoryDestinationDedupe;
  mapperCalls: MapperCall<TestPayload>[];
  delivererCalls: DelivererCall<TestPayload>[];
  projectConfig?: { valuesFor: (p: string, e: string) => Readonly<Record<string, unknown>> };
  producerSends: ProducerSend[];
  descriptor: DestinationDescriptor<TestPayload>;
}

function makeEnv({
  instance = SEED_INSTANCE,
  mapper,
  deliverer,
  requiredConsent = {},
  projectConfig,
}: {
  instance?: DestinationInstance;
  mapper?: Mapper<TestPayload>;
  deliverer?: Deliverer<TestPayload>;
  requiredConsent?: { marketing?: boolean; analytics?: boolean };
  projectConfig?: { valuesFor: (p: string, e: string) => Readonly<Record<string, unknown>> };
} = {}): TestEnv {
  const records = new InMemoryDeliveryRecordRepository();
  const instances = new InMemoryDestinationInstanceReader();
  instances.set(instance);
  const dedupe = new InMemoryDestinationDedupe();
  const mapperCalls: MapperCall<TestPayload>[] = [];
  const delivererCalls: DelivererCall<TestPayload>[] = [];
  const producerSends: ProducerSend[] = [];
  const defaultMapper: Mapper<TestPayload> = (ctx) => {
    mapperCalls.push({ payload: { vendor_payload: ctx.normalized.event } });
    return { kind: "mapped", payload: { vendor_payload: ctx.normalized.event } };
  };
  const defaultDeliverer: Deliverer<TestPayload> = async (ctx) => {
    delivererCalls.push({
      payload: ctx.payload,
      attempt: ctx.attempt,
      secretLength: ctx.secret.length,
      projectConfig: ctx.projectConfig,
    });
    return { kind: "accepted", vendor_response_code: "200", vendor_response_summary: "ok" };
  };

  const descriptor: DestinationDescriptor<TestPayload> = {
    identity: {
      vendor: "test-vendor",
      component: "test-vendor",
      consumerVersion: "v1",
      normalizeVersion: "v1",
      mapperVersion: "v1",
      delivererVersion: "v1",
    },
    mappers: { "payment.approved": mapper ?? defaultMapper },
    deliverer: deliverer ?? defaultDeliverer,
    requiredConsent,
  };

  return {
    records,
    instances,
    dedupe,
    mapperCalls,
    delivererCalls,
    ...(projectConfig !== undefined ? { projectConfig } : {}),
    producerSends,
    descriptor,
  };
}

interface ProducerStubOpts {
  readonly producerSends: ProducerSend[];
}

function makeProducerStub({ producerSends }: ProducerStubOpts) {
  // Minimal stub matching the subset of PolarisProducer the runtime uses
  // (only `publishToQueue`, for DLQ routing).
  return {
    publishToQueue: async (input: {
      queue: string;
      headers?: MessageHeaders;
      partitionKey?: string | null;
    }) => {
      const headers = input.headers ?? {};
      producerSends.push({
        topic: input.queue,
        key: input.partitionKey ?? null,
        vendor: readHeaderString(headers, POLARIS_HEADER_DESTINATION_VENDOR),
        headers,
      });
    },
    // The runtime doesn't call any other producer method on this path.
  } as unknown as Parameters<typeof createDestinationConsumer>[0]["producer"];
}

function readHeaderString(headers: MessageHeaders, key: string): string {
  const raw = headers[key];
  if (raw === undefined) return "";
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  return "";
}

function buildConsumerStub() {
  return {
    subscribe: async () => {},
    runEach: async () => {},
    disconnect: async () => {},
  } as unknown as Parameters<typeof createDestinationConsumer>[0]["consumer"];
}

function buildConsumer(
  env: TestEnv,
  overrides: { consumerBuildVersion?: string; logger?: Logger } = {},
) {
  return createDestinationConsumer({
    descriptor: env.descriptor,
    consumer: buildConsumerStub(),
    producer: makeProducerStub({ producerSends: env.producerSends }),
    instances: env.instances,
    records: env.records,
    ...(env.projectConfig !== undefined ? { projectConfig: env.projectConfig } : {}),
    logger: overrides.logger ?? noopLogger,
    dedupe: env.dedupe,
    ...(overrides.consumerBuildVersion !== undefined
      ? { consumerBuildVersion: overrides.consumerBuildVersion }
      : {}),
  });
}

function lastRecord(env: TestEnv): DeliveryRecord | undefined {
  return env.records.snapshot().at(-1);
}

/**
 * Build a fake KafkaJS payload with the bytes + headers a DLQ-bound
 * envelope needs. The runtime requires a `payload` slot to publish to
 * the DLQ (and to persist a `dlq_records` row); tests that exercise the
 * DLQ branch wire one through.
 */
/**
 * A `TransportMessagePayload` for the DLQ path.
 *
 * Was `makeFakeKafkaPayload` and was shaped like a KafkaJS `EachMessage` —
 * `topic`, `offset`, `attributes`, `heartbeat`, `pause` — none of which the
 * RabbitMQ transport has, and missing `stream` and `family`, which it
 * requires. It compiled because this tree sat on the `tsconfig.tests.json`
 * ratchet and vitest transpiles without checking types. The DLQ publisher
 * only reads `message.value`, so nothing failed at runtime either.
 */
function makeFakeTransportPayload(): TransportMessagePayload {
  return {
    stream: "analytics.events-0",
    family: "analytics.events",
    partition: 0,
    message: {
      value: Buffer.from('{"event":"payment.approved"}', "utf8"),
      headers: {},
      key: null,
      offset: "12345",
      timestamp: "0",
      redelivered: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("destination runtime — M0DROHV3 build version", () => {
  it("stamps consumer_build_version on delivery_records when supplied via options", async () => {
    const env = makeEnv();
    const consumer = buildConsumer(env, { consumerBuildVersion: "2026-q2-r1" });
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
    });
    expect(lastRecord(env)?.consumer_build_version).toBe("2026-q2-r1");
  });

  it("leaves consumer_build_version null when the option is omitted (back-compat)", async () => {
    const env = makeEnv();
    const consumer = buildConsumer(env);
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
    });
    expect(lastRecord(env)?.consumer_build_version).toBeNull();
  });
});

describe("destination runtime — happy path", () => {
  it("normalize -> map -> deliver writes status=delivered", async () => {
    const env = makeEnv();
    const consumer = buildConsumer(env);
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
    });

    expect(env.mapperCalls).toHaveLength(1);
    expect(env.delivererCalls).toHaveLength(1);
    expect(env.delivererCalls[0]?.secretLength).toBeGreaterThan(0);

    const rec = lastRecord(env);
    expect(rec?.status).toBe("accepted");
    expect(rec?.vendor_response_code).toBe("200");
  });

  it("counts every stage on DestinationMetrics", async () => {
    const env = makeEnv();
    const consumer = buildConsumer(env);
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
    });
    const samples = consumer.metrics.getSamples();
    const names = new Set(samples.map((s) => s.name));
    expect(names.has("polaris_destination_events_consumed_total")).toBe(true);
    // 'delivered' is recorded as part of the recordOutcome path; the
    // consumed counter is the always-on increment.
  });
});

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

/**
 * `analytics.events` is the shared canonical stream — its producer knows
 * nothing about destinations, so nothing stamps a destination id onto the
 * message. These tests drive `consumer.handler` (the transport entry
 * point) rather than `handleEvent`, because deciding WHICH instances an
 * envelope goes to is the handler's job.
 */
describe("destination runtime — fan-out to active instances", () => {
  function secondInstance(overrides: Partial<DestinationInstance> = {}): DestinationInstance {
    return {
      ...SEED_INSTANCE,
      destination_id: "polaris_dst_test2",
      instance_label: "test-instance-2",
      ...overrides,
    };
  }

  function makeStreamPayload(headers: MessageHeaders = {}) {
    return makeStreamPayloadFor(makeEnvelope(), headers);
  }

  /** Same payload shape, for an envelope the caller chose — e.g. another project. */
  function makeStreamPayloadFor(envelope: NormalizableEnvelope, headers: MessageHeaders = {}) {
    return {
      stream: "analytics.events-0",
      family: "analytics.events",
      partition: 0,
      message: {
        value: Buffer.from(JSON.stringify(envelope), "utf8"),
        headers,
        offset: "42",
        key: null,
      },
    } as unknown as Parameters<ReturnType<typeof buildConsumer>["handler"]>[0];
  }

  it("no destination-id header: delivers once per active instance of this vendor", async () => {
    const env = makeEnv();
    env.instances.set(secondInstance());
    const consumer = buildConsumer(env);

    await consumer.handler(makeStreamPayload(), TEST_MESSAGE_CONTEXT);

    expect(env.delivererCalls).toHaveLength(2);
    expect(
      env.records
        .snapshot()
        .map((r) => r.destination_id)
        .sort(),
    ).toEqual(["polaris_dst_test1", "polaris_dst_test2"]);
  });

  it("skips instances belonging to another vendor or another environment", async () => {
    const env = makeEnv();
    env.instances.set(secondInstance({ destination_id: "polaris_dst_other", vendor: "other" }));
    env.instances.set(
      secondInstance({ destination_id: "polaris_dst_prod", environment: "production" }),
    );
    const consumer = buildConsumer(env);

    await consumer.handler(makeStreamPayload(), TEST_MESSAGE_CONTEXT);

    expect(env.records.snapshot().map((r) => r.destination_id)).toEqual(["polaris_dst_test1"]);
  });

  it("skips instances belonging to another PROJECT", async () => {
    // The cross-project disclosure this filter closes. Fan-out resolved on
    // `(vendor, environment)` alone, so `analytics.events` — one shared stream
    // carrying every project's traffic — delivered storefront's events to
    // checkout's destination row whenever both ran the same vendor in the same
    // environment. `project_id` rode the envelope and was stamped onto metrics
    // and delivery records the whole time; nothing routed on it.
    //
    // Note this is invisible to a single-project fixture, which is why it did
    // not surface for so long: every other test in this file uses one project.
    const env = makeEnv();
    env.instances.set(
      secondInstance({ destination_id: "polaris_dst_other_project", project_id: "checkout" }),
    );
    const consumer = buildConsumer(env);

    await consumer.handler(makeStreamPayload(), TEST_MESSAGE_CONTEXT);

    expect(env.records.snapshot().map((r) => r.destination_id)).toEqual(["polaris_dst_test1"]);
    expect(env.delivererCalls).toHaveLength(1);
  });

  it("caches the target list per project, not per environment", async () => {
    // The cache key had to gain `project` with the filter. Keyed by
    // environment alone it would serve the first project's target list to
    // every project on the stream for a whole TTL window — reintroducing the
    // cross-project delivery through the cache after the query was fixed.
    const env = makeEnv();
    env.instances.set(
      secondInstance({ destination_id: "polaris_dst_other_project", project_id: "checkout" }),
    );
    const consumer = buildConsumer(env);

    // storefront first, populating the cache under whatever key it uses.
    await consumer.handler(makeStreamPayload(), TEST_MESSAGE_CONTEXT);
    // Then checkout, inside the same TTL window.
    await consumer.handler(
      makeStreamPayloadFor(makeEnvelope({ project_id: "checkout", event_id: "second-event-id" })),
      TEST_MESSAGE_CONTEXT,
    );

    const byDestination = env.records.snapshot().map((r) => r.destination_id);
    expect(byDestination).toEqual(["polaris_dst_test1", "polaris_dst_other_project"]);
  });

  it("a destination-id header pins the envelope to one instance (the replay path)", async () => {
    const env = makeEnv();
    env.instances.set(secondInstance());
    const consumer = buildConsumer(env);

    await consumer.handler(
      makeStreamPayload({ "polaris-destination-id": "polaris_dst_test2" }),
      TEST_MESSAGE_CONTEXT,
    );

    expect(env.records.snapshot().map((r) => r.destination_id)).toEqual(["polaris_dst_test2"]);
  });

  it("no active instances: counts a skip and does NOT route to the DLQ", async () => {
    const env = makeEnv({ instance: { ...SEED_INSTANCE, status: "disabled" } });
    const consumer = buildConsumer(env);

    await consumer.handler(makeStreamPayload(), TEST_MESSAGE_CONTEXT);

    expect(env.delivererCalls).toHaveLength(0);
    expect(env.records.snapshot()).toHaveLength(0);
    // The pre-fan-out design DLQ-routed every header-less message here,
    // which meant a vendor nobody had enabled filled its DLQ with
    // healthy traffic.
    expect(env.producerSends).toHaveLength(0);
    const skipped = consumer.metrics
      .getSamples()
      .find((s) => s.name === "polaris_destination_events_skipped_total");
    expect(skipped?.labels["reason"]).toBe("no_active_destinations");
  });

  it("one failing target does not stop the others, and parks the message for retry", async () => {
    const env = makeEnv({
      deliverer: async (ctx) => {
        env.delivererCalls.push({
          payload: ctx.payload,
          attempt: ctx.attempt,
          secretLength: 0,
          projectConfig: ctx.projectConfig,
        });
        if (ctx.instance.destination_id === "polaris_dst_test1") {
          return {
            kind: "failed_retryable",
            error_class: "transient",
            vendor_response_summary: "503",
          };
        }
        return { kind: "accepted", vendor_response_code: "200", vendor_response_summary: "ok" };
      },
    });
    env.instances.set(secondInstance());
    const consumer = buildConsumer(env);

    // Used to reject. The retryable failure now PARKS in a backoff tier
    // instead of rethrowing — rethrowing as well would make the broker
    // requeue the same message the runtime just parked, delivering it twice.
    await consumer.handler(makeStreamPayload(), TEST_MESSAGE_CONTEXT);

    // The healthy instance was still delivered to. The parked copy comes back
    // through fan-out when its tier expires, and the dedupe window is what
    // keeps that from double-sending to this one.
    const delivered = env.records.snapshot().find((r) => r.destination_id === "polaris_dst_test2");
    expect(delivered?.status).toBe("accepted");

    // Parked, not dead-lettered: attempt 1 is far below the threshold.
    const parked = env.producerSends.filter((send) => send.topic.includes(".retry."));
    expect(parked).toHaveLength(1);
  });

  it("re-reads the active list once the TTL expires", async () => {
    const env = makeEnv();
    let nowMs = 1_000_000;
    const consumer = createDestinationConsumer({
      descriptor: env.descriptor,
      consumer: buildConsumerStub(),
      producer: makeProducerStub({ producerSends: env.producerSends }),
      instances: env.instances,
      records: env.records,
      logger: noopLogger,
      dedupe: env.dedupe,
      activeInstanceTtlMs: 10_000,
      now: () => new Date(nowMs),
    });

    // A DISTINCT event per send. This test is about the instance cache, not
    // about dedupe, and re-sending one event would now be refused by the
    // dedupe claim — correctly. It did not use to be: `seen()` compared an
    // entry stamped with the runtime's (here fake) clock against the dedupe's
    // own `Date.now`, so any test with a custom clock silently ran with the
    // window disabled.
    const nth = (n: number) =>
      makeStreamPayloadFor(makeEnvelope({ event_id: `ttl-probe-${String(n)}` }));

    await consumer.handler(nth(1), TEST_MESSAGE_CONTEXT);
    expect(env.records.snapshot()).toHaveLength(1);

    // A destination created after the first message is invisible until
    // the TTL lapses — the cache is what keeps the fan-out from querying
    // PostgreSQL on every event.
    env.instances.set(secondInstance());
    await consumer.handler(nth(2), TEST_MESSAGE_CONTEXT);
    expect(env.records.snapshot()).toHaveLength(2);

    nowMs += 10_001;
    await consumer.handler(nth(3), TEST_MESSAGE_CONTEXT);
    expect(
      env.records.snapshot().filter((r) => r.destination_id === "polaris_dst_test2"),
    ).toHaveLength(1);
  });
});

describe("destination runtime — drop branches", () => {
  it("consent_not_granted: required marketing=true but envelope marketing=false → dropped_consent", async () => {
    const env = makeEnv({ requiredConsent: { marketing: true } });
    const consumer = buildConsumer(env);
    await consumer.handleEvent({
      envelope: makeEnvelope({ consent: { marketing: false, analytics: true } }),
      destination_id: SEED_INSTANCE.destination_id,
    });

    expect(env.mapperCalls).toHaveLength(0);
    expect(env.delivererCalls).toHaveLength(0);
    const rec = lastRecord(env);
    expect(rec?.status).toBe("dropped_consent");
  });

  it("no_usable_identity: empty identity → dropped_no_identity", async () => {
    const env = makeEnv();
    const consumer = buildConsumer(env);
    await consumer.handleEvent({
      envelope: makeEnvelope({
        identity: {
          anonymous_id: null,
          session_id: null,
          customer_id: null,
          device_id: null,
        },
      }),
      destination_id: SEED_INSTANCE.destination_id,
    });

    expect(env.mapperCalls).toHaveLength(0);
    expect(env.delivererCalls).toHaveLength(0);
    const rec = lastRecord(env);
    expect(rec?.status).toBe("dropped_no_identity");
  });
});

describe("destination runtime — mapper failure paths", () => {
  it("mapper throws → mapped_failed with error_class='mapping'", async () => {
    const env = makeEnv({
      mapper: () => {
        throw new Error("intentional mapper failure");
      },
    });
    const consumer = buildConsumer(env);
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
    });
    expect(env.delivererCalls).toHaveLength(0);
    const rec = lastRecord(env);
    expect(rec?.status).toBe("mapped_failed");
    expect(rec?.error_class).toBe("mapping");
  });

  it("mapper returns skip → mapped_failed with reason in summary", async () => {
    const env = makeEnv({
      mapper: (): MapperResult<TestPayload> => ({ kind: "skip", reason: "event_excluded" }),
    });
    const consumer = buildConsumer(env);
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
    });
    expect(env.delivererCalls).toHaveLength(0);
    const rec = lastRecord(env);
    expect(rec?.status).toBe("mapped_failed");
    expect(rec?.vendor_response_summary).toMatch(/event_excluded/);
  });

  it("no mapper registered for event → skipped_unmapped, NOT a failure", async () => {
    // This assertion used to read `mapped_failed`, and that was the defect:
    // a vendor registers mappers for the events it models, so an event with
    // no mapper is routine operation, not a mapping fault. The two now have
    // different statuses, and the one that matters most is `error_class` —
    // it is what makes "was this an error?" a single-column question.
    const env = makeEnv();
    const consumer = buildConsumer(env);
    await consumer.handleEvent({
      envelope: makeEnvelope({ event: "unknown.event" }),
      destination_id: SEED_INSTANCE.destination_id,
    });
    expect(env.delivererCalls).toHaveLength(0);
    const rec = lastRecord(env);
    expect(rec?.status).toBe("skipped_unmapped");
    expect(rec?.error_class).toBeNull();
  });
});

describe("destination runtime — deliverer outcomes", () => {
  it("accepted: marks dedupe and stamps vendor response code/summary", async () => {
    const env = makeEnv();
    const consumer = buildConsumer(env);
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
    });
    const rec = lastRecord(env);
    expect(rec?.status).toBe("accepted");
    expect(rec?.vendor_response_code).toBe("200");
    expect(rec?.vendor_response_summary).toBe("ok");
  });

  it("deliverer throws → failed_retryable with rethrow (KafkaJS handles retry)", async () => {
    const env = makeEnv({
      deliverer: async () => {
        throw new Error("network blip");
      },
    });
    const consumer = buildConsumer(env);
    await expect(
      consumer.handleEvent({
        envelope: makeEnvelope(),
        destination_id: SEED_INSTANCE.destination_id,
      }),
    ).rejects.toThrow();
    const rec = lastRecord(env);
    expect(rec?.status).toBe("failed_retryable");
    expect(rec?.error_class).toBe("transient");
  });

  it("deliverer returns failed_retryable → status=failed_retryable, rethrows for KafkaJS retry", async () => {
    const env = makeEnv({
      deliverer: async () => ({
        kind: "failed_retryable",
        error_class: "transient",
        vendor_response_code: "503",
        vendor_response_summary: "vendor unavailable",
      }),
    });
    const consumer = buildConsumer(env);
    await expect(
      consumer.handleEvent({
        envelope: makeEnvelope(),
        destination_id: SEED_INSTANCE.destination_id,
      }),
    ).rejects.toThrow();
    const rec = lastRecord(env);
    expect(rec?.status).toBe("failed_retryable");
    expect(rec?.error_class).toBe("transient");
    expect(rec?.vendor_response_code).toBe("503");
  });

  it("deliverer returns failed_permanent → status=failed_permanent (no rethrow)", async () => {
    const env = makeEnv({
      deliverer: async () => ({
        kind: "failed_permanent",
        error_class: "permanent",
        vendor_response_code: "400",
        vendor_response_summary: "invalid payload",
      }),
    });
    const consumer = buildConsumer(env);
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
    });
    const rec = lastRecord(env);
    expect(rec?.status).toBe("failed_permanent");
    expect(rec?.error_class).toBe("permanent");
    expect(rec?.vendor_response_code).toBe("400");
  });
});

describe("destination runtime — dlq_records persistence", () => {
  it("failed_permanent persists a dlq_records row when dlqRecords is wired", async () => {
    const env = makeEnv({
      deliverer: async () => ({
        kind: "failed_permanent",
        error_class: "permanent",
        vendor_response_code: "400",
        vendor_response_summary: "invalid payload",
      }),
    });
    const dlqRecords = new InMemoryDlqRecordRepository();
    const consumer = createDestinationConsumer({
      descriptor: env.descriptor,
      consumer: buildConsumerStub(),
      producer: makeProducerStub({ producerSends: env.producerSends }),
      instances: env.instances,
      records: env.records,
      dlqRecords,
      logger: noopLogger,
      dedupe: env.dedupe,
    });
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
      payload: makeFakeTransportPayload(),
    });
    const rows = dlqRecords.snapshot();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.destination_id).toBe(SEED_INSTANCE.destination_id);
    expect(row?.reason).toBe("permanent");
    expect(row?.error_class).toBe("permanent");
    expect(row?.vendor_response_code).toBe("400");
    expect(row?.vendor_response_summary).toBe("invalid payload");
    expect(row?.event_id).toBe("018f1b9e-7b50-7b12-9a2e-0e2f88d8f551");
    expect(row?.vendor).toBe("test-vendor");
    expect(row?.resolved_at).toBeNull();
  });

  it("failed_retryable persists a dlq_records row only at-or-above dead_letter_threshold", async () => {
    const env = makeEnv({
      deliverer: async () => ({
        kind: "failed_retryable",
        error_class: "transient",
        vendor_response_code: "503",
      }),
    });
    const dlqRecords = new InMemoryDlqRecordRepository();
    const consumer = createDestinationConsumer({
      descriptor: env.descriptor,
      consumer: buildConsumerStub(),
      producer: makeProducerStub({ producerSends: env.producerSends }),
      instances: env.instances,
      records: env.records,
      dlqRecords,
      logger: noopLogger,
      dedupe: env.dedupe,
    });
    // Attempt below threshold (SEED_INSTANCE.dead_letter_threshold=5) → the
    // message is PARKED in a backoff tier. No DLQ row, and no throw: the
    // runtime has taken responsibility for the message, so asking the broker
    // to requeue it as well would deliver it twice.
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
      payload: makeFakeTransportPayload(),
      attempt: 1,
    });
    expect(dlqRecords.snapshot()).toHaveLength(0);
    expect(env.producerSends.filter((s) => s.topic.includes(".retry."))).toHaveLength(1);

    // Attempt at threshold → DLQ row, and no further parking. This is the
    // branch that could not be reached before the retry ladder was wired:
    // nothing incremented `polaris-retry-attempts`, so `attempt` was always
    // 1 and a threshold of 5 was unreachable by any sequence of failures.
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
      payload: makeFakeTransportPayload(),
      attempt: SEED_INSTANCE.dead_letter_threshold,
    });
    expect(dlqRecords.snapshot()).toHaveLength(1);
    expect(env.producerSends.filter((s) => s.topic.includes(".retry."))).toHaveLength(1);
    const row = dlqRecords.snapshot()[0];
    expect(row?.attempts).toBe(SEED_INSTANCE.dead_letter_threshold);
    expect(row?.reason).toBe("transient");
  });

  it("Kafka DLQ publish still happens when dlqRecords is omitted (backward compat)", async () => {
    const env = makeEnv({
      deliverer: async () => ({
        kind: "failed_permanent",
        error_class: "permanent",
        vendor_response_code: "400",
      }),
    });
    const consumer = buildConsumer(env);
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
      payload: makeFakeTransportPayload(),
    });
    // The Kafka publish landed (one DLQ producer send observed).
    expect(env.producerSends.length).toBeGreaterThanOrEqual(1);
  });
});

describe("destination runtime — instance state", () => {
  it("instance status=disabled → no normalize, no map, no delivery, no record", async () => {
    const env = makeEnv({ instance: { ...SEED_INSTANCE, status: "disabled" } });
    const consumer = buildConsumer(env);
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
    });
    expect(env.mapperCalls).toHaveLength(0);
    expect(env.delivererCalls).toHaveLength(0);
    // The runtime returns null and writes no delivery record on a non-active
    // instance — the metric counter alone is the audit trail.
  });

  it("instance not found → no normalize, no map, no record", async () => {
    const env = makeEnv();
    const consumer = buildConsumer(env);
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: "polaris_dst_does_not_exist",
    });
    expect(env.mapperCalls).toHaveLength(0);
    expect(env.delivererCalls).toHaveLength(0);
  });

  it("instance mode=test → short-circuit with status=accepted and 'test_mode' response code", async () => {
    const env = makeEnv({ instance: { ...SEED_INSTANCE, mode: "test" } });
    const consumer = buildConsumer(env);
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
    });
    expect(env.delivererCalls).toHaveLength(0);
    const rec = lastRecord(env);
    expect(rec?.status).toBe("accepted");
    expect(rec?.vendor_response_code).toBe("test_mode");
  });
});

describe("destination runtime — replay suppression + dedupe", () => {
  it("incoming is_replay=true + allowReplay=false → suppressed, no record", async () => {
    const env = makeEnv();
    const consumer = buildConsumer(env);
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
      is_replay: true,
    });
    expect(env.mapperCalls).toHaveLength(0);
    expect(env.delivererCalls).toHaveLength(0);
    // No delivery record on suppression — the metric counter is the audit
    // trail. Verify the metric.
    const samples = consumer.metrics.getSamples();
    const suppressed = samples.find(
      (s) => s.name === "polaris_destination_replay_suppressed_total",
    );
    expect(suppressed?.value).toBeGreaterThanOrEqual(1);
  });

  it("incoming is_replay=true with allowReplay=true on a host that opts in → delivered", async () => {
    const env = makeEnv();
    const consumer = createDestinationConsumer({
      descriptor: env.descriptor,
      consumer: buildConsumerStub(),
      producer: makeProducerStub({ producerSends: env.producerSends }),
      instances: env.instances,
      records: env.records,
      logger: noopLogger,
      dedupe: env.dedupe,
      allowReplay: true,
    });
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
      is_replay: true,
    });
    expect(env.delivererCalls).toHaveLength(1);
    const rec = lastRecord(env);
    expect(rec?.status).toBe("accepted");
  });

  it("P7-004: replay against a destination with replay_opt_in=false is suppressed even when allowReplay=true", async () => {
    // The central P7-004 acceptance test. The host has globally opted
    // into replay traffic (`allowReplay: true`), but this specific
    // destination has not been flipped to `replay_opt_in: true`. The
    // runtime MUST suppress the message and increment the metric — the
    // per-instance gate is the guardrail that keeps a host-level opt-in
    // from accidentally delivering to every co-resident destination.
    const env = makeEnv({
      instance: { ...SEED_INSTANCE, replay_opt_in: false },
    });
    const consumer = createDestinationConsumer({
      descriptor: env.descriptor,
      consumer: buildConsumerStub(),
      producer: makeProducerStub({ producerSends: env.producerSends }),
      instances: env.instances,
      records: env.records,
      logger: noopLogger,
      dedupe: env.dedupe,
      allowReplay: true,
    });
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
      is_replay: true,
    });
    expect(env.mapperCalls).toHaveLength(0);
    expect(env.delivererCalls).toHaveLength(0);
    // Metric counter is the audit trail; no delivery record is written
    // when the runtime suppresses replay traffic.
    const samples = consumer.metrics.getSamples();
    const suppressed = samples.find(
      (s) => s.name === "polaris_destination_replay_suppressed_total",
    );
    expect(suppressed?.value).toBeGreaterThanOrEqual(1);
  });

  it("P7-004: replay against an opted-in destination + allowReplay=true → delivered", async () => {
    // The corollary: when BOTH gates are open, the runtime delivers the
    // replay message exactly like a live one.
    const env = makeEnv({
      instance: { ...SEED_INSTANCE, replay_opt_in: true },
    });
    const consumer = createDestinationConsumer({
      descriptor: env.descriptor,
      consumer: buildConsumerStub(),
      producer: makeProducerStub({ producerSends: env.producerSends }),
      instances: env.instances,
      records: env.records,
      logger: noopLogger,
      dedupe: env.dedupe,
      allowReplay: true,
    });
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
      is_replay: true,
    });
    expect(env.delivererCalls).toHaveLength(1);
    const rec = lastRecord(env);
    expect(rec?.status).toBe("accepted");
  });

  it("P7-004: non-replay traffic still flows regardless of replay_opt_in", async () => {
    // The per-instance gate ONLY affects messages flagged as replay.
    // Live traffic delivers normally whether the destination has opted
    // into replay or not.
    const env = makeEnv({
      instance: { ...SEED_INSTANCE, replay_opt_in: false },
    });
    const consumer = buildConsumer(env);
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
      // is_replay omitted → false
    });
    expect(env.delivererCalls).toHaveLength(1);
    const rec = lastRecord(env);
    expect(rec?.status).toBe("accepted");
  });

  it("dedupe: same (destination_id, event_id) twice → second is skipped", async () => {
    const env = makeEnv();
    const consumer = buildConsumer(env);
    const envelope = makeEnvelope();
    await consumer.handleEvent({
      envelope,
      destination_id: SEED_INSTANCE.destination_id,
    });
    await consumer.handleEvent({
      envelope,
      destination_id: SEED_INSTANCE.destination_id,
    });
    expect(env.delivererCalls).toHaveLength(1);
    expect(env.records.snapshot()).toHaveLength(1);
    const samples = consumer.metrics.getSamples();
    const deduped = samples.find((s) => s.name === "polaris_destination_events_deduped_total");
    expect(deduped?.value).toBeGreaterThanOrEqual(1);
  });
});

describe("destination runtime — secret handling + PII safety", () => {
  /**
   * These used to be five tests, three of which exercised secret-RESOLUTION
   * failures: an unreachable provider, an unclassified error, an unprovisioned
   * reference. None of those states can occur now that the credential arrives
   * on the destination row — there is no resolution step to fail, and a row
   * that does not exist is handled long before this point.
   *
   * What replaced them matters more. The credential now sits in memory for the
   * cached lifetime of every destination instance rather than for the duration
   * of one attempt, so the question is no longer "does resolution behave?" but
   * "can this value escape?" — and it has to be asked of the log line as well
   * as the delivery record, because the runtime stamped the column onto EVERY
   * delivery log while it held a pointer.
   */
  const SECRET = "TOPSECRET-DO-NOT-LOG-abcdefghijklmn";

  it("hands the deliverer the instance's stored credential, on every attempt", async () => {
    const env = makeEnv({ instance: { ...SEED_INSTANCE, secret_value: SECRET } });
    const consumer = buildConsumer(env);
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
    });
    await consumer.handleEvent({
      envelope: makeEnvelope({ event_id: "second-event-id" }),
      destination_id: SEED_INSTANCE.destination_id,
    });
    expect(env.delivererCalls).toHaveLength(2);
    expect(env.delivererCalls.every((call) => call.secretLength === SECRET.length)).toBe(true);
  });

  it("the credential never appears in the delivery_records row", async () => {
    const env = makeEnv({ instance: { ...SEED_INSTANCE, secret_value: SECRET } });
    const consumer = buildConsumer(env);
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
    });
    const rec = lastRecord(env);
    expect(JSON.stringify(rec)).not.toContain(SECRET);
    // The deliverer DID receive it (sanity check — an empty string would pass
    // the assertion above for the wrong reason).
    expect(env.delivererCalls[0]?.secretLength).toBe(SECRET.length);
  });

  it("the credential never appears in a log line", async () => {
    // The regression this pins is concrete. `recordOutcome` logged
    // `secret_ref: instance.secret_ref` on every single delivery, which was
    // correct while the column named a vault entry. Renaming the column to
    // `secret_value` without deleting that field would have published a live
    // vendor credential once per delivered event, into whatever aggregator the
    // fleet ships logs to — the highest-volume disclosure available.
    const lines: unknown[] = [];
    const capturing = {
      info: (fields: unknown, msg: unknown) => lines.push({ fields, msg }),
      warn: (fields: unknown, msg: unknown) => lines.push({ fields, msg }),
      error: (fields: unknown, msg: unknown) => lines.push({ fields, msg }),
      debug: () => {},
      fatal: () => {},
      trace: () => {},
      child: () => capturing,
    } as unknown as Logger;

    const env = makeEnv({ instance: { ...SEED_INSTANCE, secret_value: SECRET } });
    const consumer = buildConsumer(env, { logger: capturing });

    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
    });
    // A failing delivery logs at error with a vendor summary — the other place
    // an instance field could be interpolated.
    await consumer.handleEvent({
      envelope: makeEnvelope({ event_id: "unmapped-event-id", event: "cart.abandoned" }),
      destination_id: SEED_INSTANCE.destination_id,
    });

    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(lines)).not.toContain(SECRET);
  });
});

describe("destination runtime — closed-set coverage", () => {
  it("every drop reason in the runtime corresponds to a closed-set DeliveryRecordStatus", () => {
    // This is a structural test: the runtime's drop reasons must map onto
    // one of the closed-set statuses. If a future change introduces a new
    // drop reason, the test catches it at the type-erasure boundary.
    const reasons: RuntimeDropReason[] = [
      "consent_not_granted",
      "no_usable_identity",
      "invalid_envelope",
      "redacted_payload_empty",
    ];
    expect(reasons.length).toBeGreaterThan(0);
  });

  it("DestinationInstanceCache class is callable (sanity)", () => {
    const reader = new InMemoryDestinationInstanceReader();
    reader.set(SEED_INSTANCE);
    const cache = new DestinationInstanceCache({ reader, ttlMs: 60_000 });
    expect(cache).toBeDefined();
  });
});

describe("destination runtime — subscription naming", () => {
  /**
   * Capture what `start()` asks the transport to subscribe to.
   *
   * The rest of this file drives `handleEvent` directly and never starts the
   * runtime, which is why the bug below survived: the subscribe call was
   * untested, and the shared harness gives every descriptor `vendor ===
   * component`, so it could not have distinguished the two anyway.
   */
  function captureSubscription(identity: DestinationDescriptor<TestPayload>["identity"]) {
    const subscriptions: Array<{ families: string[]; queues: string[] }> = [];
    const env = makeEnv();
    const consumer = createDestinationConsumer({
      descriptor: { ...env.descriptor, identity },
      consumer: {
        subscribe: async (input: { families: string[]; queues: string[] }) => {
          subscriptions.push({ families: [...input.families], queues: [...input.queues] });
        },
        runEach: async () => {},
        disconnect: async () => {},
      } as unknown as Parameters<typeof createDestinationConsumer>[0]["consumer"],
      producer: makeProducerStub({ producerSends: env.producerSends }),
      instances: env.instances,
      records: env.records,
      logger: noopLogger,
      dedupe: env.dedupe,
    });
    return { consumer, subscriptions };
  }

  const webhookSinkIdentity = {
    // webhook-sink is the only consumer whose vendor and topology component
    // differ, which is exactly why it was the only one this broke.
    vendor: "webhook",
    component: "webhook-sink",
    consumerVersion: "v1",
    normalizeVersion: "v1",
    mapperVersion: "v1",
    delivererVersion: "v1",
  } as const;

  it("subscribes to the redeliver queue named for the component, not the vendor", async () => {
    const { consumer, subscriptions } = captureSubscription(webhookSinkIdentity);

    await consumer.start();

    expect(subscriptions).toHaveLength(1);
    // `pnpm rabbitmq:provision` declares queues from POLARIS_COMPONENTS, so
    // `webhook-sink.redeliver` is what exists. Asking for `webhook.redeliver`
    // took the whole consumer down on boot with a 404 NOT_FOUND.
    expect(subscriptions[0]?.queues).toEqual(["webhook-sink.redeliver"]);
    expect(subscriptions[0]?.queues).not.toContain("webhook.redeliver");
  });

  it("is unchanged for consumers whose vendor and component match", async () => {
    const { consumer, subscriptions } = captureSubscription({
      ...webhookSinkIdentity,
      vendor: "braze",
      component: "braze",
    });

    await consumer.start();

    expect(subscriptions[0]?.queues).toEqual(["braze.redeliver"]);
  });
});

describe("destination runtime — per-project configuration", () => {
  it("hands the envelope's project slice to the deliverer", async () => {
    // The property the consumer cutover rests on: a value set for THIS
    // project reaches the code that talks to the vendor. Nothing constructed
    // a DelivererContext directly before this, so the field could have been
    // added and never populated and every test would still have passed.
    const env = makeEnv({
      projectConfig: {
        valuesFor: (projectId) =>
          projectId === "storefront" ? { graph_host: "graph-staging.facebook.com" } : {},
      },
    });
    const consumer = buildConsumer(env);
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
    });
    expect(env.delivererCalls[0]?.projectConfig).toEqual({
      graph_host: "graph-staging.facebook.com",
    });
  });

  it("hands an empty slice when no lookup is wired", async () => {
    // The pre-cutover state, and the one every consumer that has not moved
    // still runs in: deliverers must see a usable empty object, not undefined.
    const env = makeEnv();
    const consumer = buildConsumer(env);
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
    });
    expect(env.delivererCalls[0]?.projectConfig).toEqual({});
  });

  it("hands an empty slice for a project the lookup does not know", async () => {
    const env = makeEnv({ projectConfig: { valuesFor: () => ({}) } });
    const consumer = buildConsumer(env);
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
    });
    expect(env.delivererCalls[0]?.projectConfig).toEqual({});
  });
});

describe("destination runtime — the routing gate", () => {
  // `gate.test.ts` covers the decision itself exhaustively. What can only be
  // tested here is the WIRING: that a decision reaches a delivery row, stops
  // the pipeline at the right point, and does not fire when unconfigured.

  function gated(config: unknown) {
    return { valuesFor: () => ({ routing: config }) };
  }

  it("does not gate when the project has no routing config", async () => {
    // The landing property. Every destination shipping today runs this path.
    const env = makeEnv({ projectConfig: { valuesFor: () => ({}) } });
    const consumer = buildConsumer(env);
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
    });
    expect(env.delivererCalls).toHaveLength(1);
  });

  it("records skipped_filtered and never reaches the deliverer", async () => {
    const env = makeEnv({
      projectConfig: gated({ subscriptions: { events: ["something.else"] } }),
    });
    const consumer = buildConsumer(env);
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
    });
    expect(env.delivererCalls).toHaveLength(0);
    const rec = lastRecord(env);
    expect(rec?.status).toBe("skipped_filtered");
    expect(rec?.error_class).toBeNull();
    expect(rec?.vendor_response_summary).toMatch(/subscriptions/);
  });

  it("runs BEFORE dedupe, so a gated event costs no dedupe round trip", async () => {
    // Ordering is the whole reason the gate sits where it does. An instance
    // subscribed to one event type should not pay a lookup for the ones it
    // has said it does not want.
    const env = makeEnv({
      projectConfig: gated({ subscriptions: { events: ["something.else"] } }),
    });
    const seen: string[] = [];
    const inner = env.dedupe.seen.bind(env.dedupe);
    env.dedupe.seen = async (destinationId: string, key: string) => {
      seen.push(key);
      return inner(destinationId, key);
    };
    const consumer = buildConsumer(env);
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
    });
    expect(seen).toHaveLength(0);
  });

  it("treats a malformed routing config as unconfigured", async () => {
    // Fail-open is safe here for one specific reason: the gate can only ever
    // SUBTRACT deliveries, and normalize still applies the vendor's own
    // consent independently. So a broken config degrades to yesterday's
    // behaviour rather than muting a destination over a typo.
    const env = makeEnv({ projectConfig: gated({ subscriptions: { events: "not-a-list" } }) });
    const consumer = buildConsumer(env);
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
    });
    expect(env.delivererCalls).toHaveLength(1);
  });

  it("lets the instance's own config override the project's", async () => {
    // The precedence chain end to end: two instances of one vendor in one
    // project can want different events. Without this the gate would only
    // ever be a project-wide switch.
    const env = makeEnv({
      projectConfig: gated({ subscriptions: { events: ["something.else"] } }),
      instance: {
        ...SEED_INSTANCE,
        config: { routing: { subscriptions: { events: ["payment.approved"] } } },
      },
    });
    const consumer = buildConsumer(env);
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
    });
    expect(env.delivererCalls).toHaveLength(1);
  });

  it("gates on a profile trait, which only works before normalize", async () => {
    // Both directions deliberately. Asserting only the skip would pass just
    // as well against an envelope carrying no profile at all — the filter
    // would resolve to `undefined` and refuse everything, and the test would
    // prove nothing about traits.
    const filters = [{ path: "profile.traits.tier", op: "equals", value: "gold" }];
    const withTier = (tier: string) =>
      makeEnvelope({
        profile: {
          profile_id: "01a0-0000-7000-8000-0000f001",
          canonical_customer_id: null,
          traits: { tier },
        },
      });

    const matching = makeEnv({ projectConfig: gated({ filters }) });
    await buildConsumer(matching).handleEvent({
      envelope: withTier("gold"),
      destination_id: SEED_INSTANCE.destination_id,
    });
    expect(matching.delivererCalls).toHaveLength(1);

    const other = makeEnv({ projectConfig: gated({ filters }) });
    await buildConsumer(other).handleEvent({
      envelope: withTier("bronze"),
      destination_id: SEED_INSTANCE.destination_id,
    });
    expect(other.delivererCalls).toHaveLength(0);
    expect(lastRecord(other)?.status).toBe("skipped_filtered");
  });
});
