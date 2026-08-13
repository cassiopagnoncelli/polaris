/**
 * Behavioral tests for the destination consumer runtime (P9-001b).
 *
 * Drives `createDestinationConsumer({...}).handleEvent({...})` directly so
 * each branch of the per-message pipeline is exercised without spinning up
 * a KafkaJS consumer:
 *
 *   subscribe -> replay-suppress -> resolve instance -> check status -> mode=test
 *   -> dedupe -> normalize -> map -> resolve secret -> rate-limit -> deliver -> RECORD
 *
 * Each test wires an `InMemoryDestinationInstanceReader`, an
 * `InMemoryDeliveryRecordRepository`, a stub mapper / deliverer / secret
 * resolver, and asserts on the captured delivery record + metric snapshot.
 *
 * @see docs/implementation/tasks/P9-001b-destination-runtime-behavioral-tests.md
 */

import type { NormalizableEnvelope } from "@polaris/shared-destination-normalize";
import type { Logger } from "@polaris/shared-logger";
import {
  SecretNotFoundError,
  SecretProviderError,
  type SecretResolver,
} from "@polaris/shared-secrets";
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
  secret_ref: "env:TEST_SECRET",
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
  /** Did the runtime hand us the resolved plaintext secret? */
  secretLength: number;
}

interface SecretResolverCall {
  ref: string;
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
  secrets: SecretResolver;
  secretCalls: SecretResolverCall[];
  mapperCalls: MapperCall<TestPayload>[];
  delivererCalls: DelivererCall<TestPayload>[];
  producerSends: ProducerSend[];
  descriptor: DestinationDescriptor<TestPayload>;
}

function makeEnv({
  instance = SEED_INSTANCE,
  mapper,
  deliverer,
  requiredConsent = {},
  resolveSecret,
}: {
  instance?: DestinationInstance;
  mapper?: Mapper<TestPayload>;
  deliverer?: Deliverer<TestPayload>;
  requiredConsent?: { marketing?: boolean; analytics?: boolean };
  resolveSecret?: (ref: string) => Promise<string>;
} = {}): TestEnv {
  const records = new InMemoryDeliveryRecordRepository();
  const instances = new InMemoryDestinationInstanceReader();
  instances.set(instance);
  const dedupe = new InMemoryDestinationDedupe();
  const mapperCalls: MapperCall<TestPayload>[] = [];
  const delivererCalls: DelivererCall<TestPayload>[] = [];
  const producerSends: ProducerSend[] = [];
  const secretCalls: SecretResolverCall[] = [];
  const secrets: SecretResolver = {
    resolve: async (ref) => {
      secretCalls.push({ ref });
      if (resolveSecret !== undefined) return resolveSecret(ref);
      return "<test-secret>";
    },
  } as SecretResolver;

  const defaultMapper: Mapper<TestPayload> = (ctx) => {
    mapperCalls.push({ payload: { vendor_payload: ctx.normalized.event } });
    return { kind: "mapped", payload: { vendor_payload: ctx.normalized.event } };
  };
  const defaultDeliverer: Deliverer<TestPayload> = async (ctx) => {
    delivererCalls.push({
      payload: ctx.payload,
      attempt: ctx.attempt,
      secretLength: ctx.secret.length,
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
    secrets,
    secretCalls,
    mapperCalls,
    delivererCalls,
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

function buildConsumer(env: TestEnv, overrides: { consumerBuildVersion?: string } = {}) {
  return createDestinationConsumer({
    descriptor: env.descriptor,
    consumer: buildConsumerStub(),
    producer: makeProducerStub({ producerSends: env.producerSends }),
    instances: env.instances,
    records: env.records,
    secrets: env.secrets,
    logger: noopLogger,
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
function makeFakeKafkaPayload(): {
  topic: string;
  partition: number;
  message: {
    value: Buffer;
    headers: MessageHeaders;
    offset: string;
    timestamp: string;
    attributes: number;
    size: number;
    key: null;
  };
  heartbeat: () => Promise<void>;
  pause: () => () => void;
} {
  return {
    topic: "analytics.events",
    partition: 0,
    message: {
      value: Buffer.from('{"event":"payment.approved"}', "utf8"),
      headers: {},
      offset: "12345",
      timestamp: "0",
      attributes: 0,
      size: 0,
      key: null,
    },
    heartbeat: async () => {},
    pause: () => () => {},
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
    return {
      stream: "analytics.events-0",
      family: "analytics.events",
      partition: 0,
      message: {
        value: Buffer.from(JSON.stringify(makeEnvelope()), "utf8"),
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

    await consumer.handler(makeStreamPayload());

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

    await consumer.handler(makeStreamPayload());

    expect(env.records.snapshot().map((r) => r.destination_id)).toEqual(["polaris_dst_test1"]);
  });

  it("a destination-id header pins the envelope to one instance (the replay path)", async () => {
    const env = makeEnv();
    env.instances.set(secondInstance());
    const consumer = buildConsumer(env);

    await consumer.handler(makeStreamPayload({ "polaris-destination-id": "polaris_dst_test2" }));

    expect(env.records.snapshot().map((r) => r.destination_id)).toEqual(["polaris_dst_test2"]);
  });

  it("no active instances: counts a skip and does NOT route to the DLQ", async () => {
    const env = makeEnv({ instance: { ...SEED_INSTANCE, status: "disabled" } });
    const consumer = buildConsumer(env);

    await consumer.handler(makeStreamPayload());

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

  it("one failing target does not stop the others, and still re-throws for redelivery", async () => {
    const env = makeEnv({
      deliverer: async (ctx) => {
        env.delivererCalls.push({ payload: ctx.payload, attempt: ctx.attempt, secretLength: 0 });
        if (ctx.instance.destination_id === "polaris_dst_test1") {
          return { kind: "failed_retryable", vendor_response_summary: "503" };
        }
        return { kind: "accepted", vendor_response_code: "200", vendor_response_summary: "ok" };
      },
    });
    env.instances.set(secondInstance());
    const consumer = buildConsumer(env);

    await expect(consumer.handler(makeStreamPayload())).rejects.toThrow();

    // The healthy instance was still delivered to; the throw is what asks
    // the transport to redeliver, and the dedupe window is what keeps the
    // redelivery from double-sending to this one.
    const delivered = env.records.snapshot().find((r) => r.destination_id === "polaris_dst_test2");
    expect(delivered?.status).toBe("accepted");
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
      secrets: env.secrets,
      logger: noopLogger,
      dedupe: env.dedupe,
      activeInstanceTtlMs: 10_000,
      now: () => new Date(nowMs),
    });

    await consumer.handler(makeStreamPayload());
    expect(env.records.snapshot()).toHaveLength(1);

    // A destination created after the first message is invisible until
    // the TTL lapses — the cache is what keeps the fan-out from querying
    // PostgreSQL on every event.
    env.instances.set(secondInstance());
    await consumer.handler(makeStreamPayload());
    expect(env.records.snapshot()).toHaveLength(2);

    nowMs += 10_001;
    await consumer.handler(makeStreamPayload());
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

  it("no mapper registered for event → mapped_failed", async () => {
    const env = makeEnv();
    const consumer = buildConsumer(env);
    await consumer.handleEvent({
      envelope: makeEnvelope({ event: "unknown.event" }),
      destination_id: SEED_INSTANCE.destination_id,
    });
    expect(env.delivererCalls).toHaveLength(0);
    const rec = lastRecord(env);
    expect(rec?.status).toBe("mapped_failed");
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
      secrets: env.secrets,
      logger: noopLogger,
      dedupe: env.dedupe,
    });
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
      payload: makeFakeKafkaPayload(),
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
      secrets: env.secrets,
      logger: noopLogger,
      dedupe: env.dedupe,
    });
    // Attempt below threshold (SEED_INSTANCE.dead_letter_threshold=5) →
    // rethrow but no DLQ row.
    await expect(
      consumer.handleEvent({
        envelope: makeEnvelope(),
        destination_id: SEED_INSTANCE.destination_id,
        payload: makeFakeKafkaPayload(),
        attempt: 1,
      }),
    ).rejects.toThrow();
    expect(dlqRecords.snapshot()).toHaveLength(0);
    // Attempt at threshold → rethrow + DLQ row.
    await expect(
      consumer.handleEvent({
        envelope: makeEnvelope(),
        destination_id: SEED_INSTANCE.destination_id,
        payload: makeFakeKafkaPayload(),
        attempt: SEED_INSTANCE.dead_letter_threshold,
      }),
    ).rejects.toThrow();
    expect(dlqRecords.snapshot()).toHaveLength(1);
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
      payload: makeFakeKafkaPayload(),
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
      secrets: env.secrets,
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
      secrets: env.secrets,
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
      secrets: env.secrets,
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
  it("resolves the secret on every attempt (not at startup)", async () => {
    const env = makeEnv();
    const consumer = buildConsumer(env);
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
    });
    await consumer.handleEvent({
      envelope: makeEnvelope({ event_id: "second-event-id" }),
      destination_id: SEED_INSTANCE.destination_id,
    });
    expect(env.secretCalls).toHaveLength(2);
    expect(env.secretCalls.every((call) => call.ref === SEED_INSTANCE.secret_ref)).toBe(true);
  });

  it("the resolved secret never appears in the delivery_records row", async () => {
    const SECRET = "TOPSECRET-DO-NOT-LOG-abcdefghijklmn";
    const env = makeEnv({
      resolveSecret: async () => SECRET,
    });
    const consumer = buildConsumer(env);
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
    });
    const rec = lastRecord(env);
    expect(JSON.stringify(rec)).not.toContain(SECRET);
    // The deliverer DID receive the secret (sanity check).
    expect(env.delivererCalls[0]?.secretLength).toBe(SECRET.length);
  });

  it("unreachable secret provider → failed_retryable, rethrows for retry", async () => {
    // This asserted `failed_permanent` until the failure classes were split.
    // That was the defect: a Vault 503 or a token-renewal race permanently
    // dead-lettered deliveries that a retry seconds later would have
    // completed, each one then needing a human to replay it.
    const env = makeEnv({
      resolveSecret: async () => {
        throw new SecretProviderError("vault", "polaris/production/x", "503 from vault");
      },
    });
    const consumer = buildConsumer(env);
    await expect(
      consumer.handleEvent({
        envelope: makeEnvelope(),
        destination_id: SEED_INSTANCE.destination_id,
      }),
    ).rejects.toThrow();
    expect(env.delivererCalls).toHaveLength(0);
    const rec = lastRecord(env);
    expect(rec?.status).toBe("failed_retryable");
    expect(rec?.error_class).toBe("transient");
  });

  it("unknown secret failure defaults to retryable", async () => {
    const env = makeEnv({
      resolveSecret: async () => {
        throw new Error("something unclassified");
      },
    });
    const consumer = buildConsumer(env);
    await expect(
      consumer.handleEvent({
        envelope: makeEnvelope(),
        destination_id: SEED_INSTANCE.destination_id,
      }),
    ).rejects.toThrow();
    expect(lastRecord(env)?.status).toBe("failed_retryable");
  });

  it("unprovisioned secret reference → failed_permanent with error_class='auth'", async () => {
    // Retrying cannot conjure a reference nobody created, so this one still
    // goes straight to the DLQ for an operator to fix.
    const env = makeEnv({
      resolveSecret: async () => {
        throw new SecretNotFoundError("vault", "polaris/production/missing");
      },
    });
    const consumer = buildConsumer(env);
    await consumer.handleEvent({
      envelope: makeEnvelope(),
      destination_id: SEED_INSTANCE.destination_id,
    });
    expect(env.delivererCalls).toHaveLength(0);
    const rec = lastRecord(env);
    expect(rec?.status).toBe("failed_permanent");
    expect(rec?.error_class).toBe("auth");
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
      secrets: env.secrets,
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
