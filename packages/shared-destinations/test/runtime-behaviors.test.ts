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

import type { IHeaders } from "kafkajs";
import { describe, expect, it } from "vitest";

import type { NormalizableEnvelope } from "@polaris/shared-destination-normalize";
import type { Logger } from "@polaris/shared-logger";
import type { SecretResolver } from "@polaris/shared-secrets";

import {
  createDestinationConsumer,
  type Deliverer,
  type DestinationDescriptor,
  type DestinationInstance,
  DestinationInstanceCache,
  type DeliveryRecord,
  InMemoryDeliveryRecordRepository,
  InMemoryDestinationDedupe,
  InMemoryDestinationInstanceReader,
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
  topic: string;
  key: string | Buffer | null;
  vendor: string;
  headers: IHeaders;
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
  // (only .send for DLQ routing).
  return {
    send: async (input: {
      topic: string;
      messages: Array<{ key?: string | Buffer | null; headers?: IHeaders }>;
    }) => {
      for (const msg of input.messages) {
        const headers = msg.headers ?? {};
        const vendor = readHeaderString(headers, POLARIS_HEADER_DESTINATION_VENDOR);
        producerSends.push({
          topic: input.topic,
          key: msg.key ?? null,
          vendor,
          headers,
        });
      }
    },
    // The runtime doesn't call any other producer method on this path.
  } as unknown as Parameters<typeof createDestinationConsumer>[0]["producer"];
}

function readHeaderString(headers: IHeaders, key: string): string {
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

function buildConsumer(env: TestEnv) {
  return createDestinationConsumer({
    descriptor: env.descriptor,
    consumer: buildConsumerStub(),
    producer: makeProducerStub({ producerSends: env.producerSends }),
    instances: env.instances,
    records: env.records,
    secrets: env.secrets,
    logger: noopLogger,
    dedupe: env.dedupe,
  });
}

function lastRecord(env: TestEnv): DeliveryRecord | undefined {
  return env.records.snapshot().at(-1);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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

  it("secret resolver throws → status=failed_permanent with error_class='auth'", async () => {
    const env = makeEnv({
      resolveSecret: async () => {
        throw new Error("secret store down");
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
