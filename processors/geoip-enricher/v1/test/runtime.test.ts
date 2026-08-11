/**
 * Streaming runtime tests for geoip-enricher v1.
 *
 * The runtime is exercised through its `handler` slot — the same
 * `TransportMessageHandler` registered with the KafkaJS consumer. We
 * synthesise a minimal `TransportMessagePayload` and assert:
 *
 *   - happy path with InMemoryIPLookup → enriched.geoip envelope is
 *     stamped correctly and published to enriched.events with the
 *     canonical partition key.
 *   - PII posture: NO RAW IP appears in ANY captured log line, even at
 *     debug level (only the SHA-256 hash).
 *   - NoOpIPLookup fail-open: emits an enriched event with all-null geo
 *     and source = "no_lookup".
 *   - idempotency: replaying the same canonical envelope yields a
 *     byte-identical properties payload (only the per-run nondeterministic
 *     fields differ).
 *   - empty/tombstone, bad JSON, missing envelope fields produce the
 *     same fail-fast behaviour as analytics-projector + identity-resolver.
 *
 * The producer is a recording stub — no RabbitMQ required.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  buildRawEventsPartitionKey,
  type PolarisConsumer,
  type TransportMessageContext,
  type PolarisProducer,
  type PublishEventInput,
  type SyncIsolationLookup,
  sharedOnlyIsolationLookup,
  STREAM_FAMILY_ENRICHED_EVENTS,
  STREAM_FAMILY_RAW_EVENTS,
  type TransportMessagePayload,
} from "@polaris/shared-transport";
import { createLogger } from "@polaris/shared-logger";
import { describe, expect, it, vi } from "vitest";

import {
  createRuntime,
  type GeoResult,
  hashIp,
  InMemoryIPLookup,
  NoOpIPLookup,
  PROCESSOR_NAME,
  PROCESSOR_VERSION,
  SOURCE_NO_LOOKUP,
} from "../src/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = join(__dirname, "fixtures", "geoip-sample.json");

function loadFixture(): Record<string, GeoResult> {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Record<string, GeoResult>;
}

const SAMPLE_ENVELOPE = {
  event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
  event: "payment.approved",
  schema_version: 1,
  project_id: "checkout",
  environment: "production",
  occurred_at: "2026-05-12T12:00:00.000Z",
  ingested_at: "2026-05-12T12:00:01.120Z",
  source: { type: "backend", id: "payments-api", sdk: "node", sdk_version: "1.0.0" },
  identity: { anonymous_id: null, session_id: null, customer_id: "cus_123", device_id: null },
  context: {
    ip: "8.8.8.8",
    user_agent: "Mozilla/5.0",
    locale: "en",
    page: null,
    campaign: null,
  },
  consent: { analytics: true, marketing: false, personalization: true },
  privacy: { classification: "internal" },
  properties: { payment_id: "pay_1" },
} as const;

const RAN_AT_ISO = "2026-05-12T12:00:02.000Z";
const FIXED_RUN_ID = "run_test_2026_05_12_001";

class RecordingProducer {
  public readonly publishes: Array<{
    family: string;
    event: Record<string, unknown>;
    partitionKey: string | undefined;
    isolation: SyncIsolationLookup;
  }> = [];
  public throwOnPublish: Error | undefined;
  public readonly raw: unknown = null;

  async connect(): Promise<void> {
    /* no-op */
  }

  async disconnect(): Promise<void> {
    /* no-op */
  }

  async publishEvent(input: PublishEventInput): Promise<unknown> {
    if (this.throwOnPublish !== undefined) {
      const err = this.throwOnPublish;
      this.throwOnPublish = undefined;
      throw err;
    }
    this.publishes.push({
      family: input.family,
      event: input.event as Record<string, unknown>,
      partitionKey: input.partitionKey,
      isolation: input.isolation,
    });
    return [];
  }

  async send(): Promise<unknown> {
    throw new Error("RecordingProducer.send not used in tests");
  }
}

/**
 * Stub consumer that satisfies the `PolarisConsumer` shape but never
 * actually subscribes to Kafka. The runtime's `start()` is not
 * exercised here — we drive `runtime.handler` directly.
 */
function stubConsumer(): PolarisConsumer {
  return {
    disconnect: vi.fn(async () => {}),
    subscribe: vi.fn(async () => {}),
    runEach: vi.fn(async () => {}),
    streams: [],
    queues: [],
  };
}

/**
 * Capture log output for the IP-leak assertion. We pipe Pino into an
 * in-memory writable stream and parse every line back. The runtime is
 * configured to log at `debug` so we exercise the most chatty path —
 * even there, no raw IP must appear.
 */
class CapturingStream extends Writable {
  public readonly chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    callback();
  }

  /** Concatenated captured output as a single string. */
  fullOutput(): string {
    return this.chunks.join("");
  }
}

function buildPayload(value: Buffer | null): TransportMessagePayload {
  return {
    stream: `${STREAM_FAMILY_RAW_EVENTS}-0`,
    family: STREAM_FAMILY_RAW_EVENTS,
    partition: 0,
    message: {
      key: "partition-key",
      value,
      offset: "42",
      headers: {},
      timestamp: "0",
      redelivered: false,
    },
  };
}

const EMPTY_CONTEXT: TransportMessageContext = {};

interface BuildRuntimeOptions {
  readonly lookup?: ConstructorParameters<typeof InMemoryIPLookup>[0];
  readonly noopLookup?: boolean;
  readonly logLevel?: "debug" | "info";
  readonly logDestination?: NodeJS.WritableStream;
  readonly newEventId?: () => string;
}

function buildRuntime(producer: PolarisProducer, options: BuildRuntimeOptions = {}) {
  const logger = createLogger({
    service: "test",
    version: "0.0.0",
    env: "local",
    level: options.logLevel ?? "info",
    ...(options.logDestination !== undefined ? { destination: options.logDestination } : {}),
  });
  const lookup = options.noopLookup
    ? new NoOpIPLookup()
    : new InMemoryIPLookup(options.lookup ?? loadFixture(), { id: "in_memory:test-fixture" });
  return createRuntime({
    consumer: stubConsumer(),
    producer,
    logger,
    lookup,
    isolation: sharedOnlyIsolationLookup,
    now: () => new Date(RAN_AT_ISO),
    run_id: FIXED_RUN_ID,
    ...(options.newEventId !== undefined ? { newEventId: options.newEventId } : {}),
  });
}

describe("createRuntime (geoip-enricher v1)", () => {
  it("publishes a transformed enriched.geoip event to enriched.events with the canonical partition key", async () => {
    const producer = new RecordingProducer();
    let eventCounter = 0;
    const runtime = buildRuntime(producer as unknown as PolarisProducer, {
      // deterministic event id so the test can assert without
      // accepting a real UUIDv7.
      newEventId: () => `evt_${++eventCounter}`,
    });

    const payload = buildPayload(Buffer.from(JSON.stringify(SAMPLE_ENVELOPE), "utf8"));
    await runtime.handler(payload, EMPTY_CONTEXT);

    expect(producer.publishes.length).toBe(1);
    const sent = producer.publishes[0];
    if (sent === undefined) throw new Error("expected one publish");
    expect(sent.family).toBe(STREAM_FAMILY_ENRICHED_EVENTS);

    // Partition key is the SAME canonical key as the source raw.events
    // record, so per-identity ordering is preserved end to end.
    const expectedKey = buildRawEventsPartitionKey({
      project_id: SAMPLE_ENVELOPE.project_id,
      environment: SAMPLE_ENVELOPE.environment,
      event_id: "evt_1",
      identity: SAMPLE_ENVELOPE.identity,
    });
    expect(sent.partitionKey).toBe(expectedKey);

    const emitted = sent.event;
    expect(emitted["event"]).toBe("enriched.geoip");
    expect(emitted["schema_version"]).toBe(1);
    expect(emitted["project_id"]).toBe(SAMPLE_ENVELOPE.project_id);
    expect(emitted["environment"]).toBe(SAMPLE_ENVELOPE.environment);
    expect(emitted["occurred_at"]).toBe(SAMPLE_ENVELOPE.occurred_at);
    // Identity is carried through verbatim.
    expect(emitted["identity"]).toEqual(SAMPLE_ENVELOPE.identity);
    // Context is INTENTIONALLY empty — the enriched event must NOT
    // carry the raw IP forward.
    expect(emitted["context"]).toEqual({
      ip: null,
      user_agent: null,
      locale: null,
      page: null,
      campaign: null,
    });
    // Processor metadata is stamped in both shapes.
    expect(emitted["processor"]).toEqual({
      name: PROCESSOR_NAME,
      version: PROCESSOR_VERSION,
      ran_at: RAN_AT_ISO,
      run_id: FIXED_RUN_ID,
    });
    expect(emitted["processor_name"]).toBe(PROCESSOR_NAME);
    expect(emitted["processor_version"]).toBe(PROCESSOR_VERSION);

    // Properties payload reflects the InMemoryIPLookup hit.
    const properties = emitted["properties"] as Record<string, unknown>;
    expect(properties["source_event_id"]).toBe(SAMPLE_ENVELOPE.event_id);
    expect(properties["source"]).toBe("in_memory:test-fixture");
    expect(properties["country_code"]).toBe("US");
    expect(properties["country_name"]).toBe("United States");
    expect(properties["region_code"]).toBe("US-CA");
    expect(properties["city"]).toBe("Mountain View");
    expect(properties["timezone"]).toBe("America/Los_Angeles");
    expect(properties["source_ip_hash"]).toBe(hashIp("8.8.8.8"));
    expect(properties["run_id"]).toBe(FIXED_RUN_ID);
  });

  it("emits a null-geo enriched event for the NoOp adapter (fail-open)", async () => {
    const producer = new RecordingProducer();
    const runtime = buildRuntime(producer as unknown as PolarisProducer, {
      noopLookup: true,
      newEventId: () => "evt_noop",
    });

    const payload = buildPayload(Buffer.from(JSON.stringify(SAMPLE_ENVELOPE), "utf8"));
    await runtime.handler(payload, EMPTY_CONTEXT);

    expect(producer.publishes.length).toBe(1);
    const sent = producer.publishes[0];
    if (sent === undefined) throw new Error("expected one publish");
    const properties = sent.event["properties"] as Record<string, unknown>;
    expect(properties["source"]).toBe(SOURCE_NO_LOOKUP);
    expect(properties["country_code"]).toBeNull();
    expect(properties["region_code"]).toBeNull();
    expect(properties["city"]).toBeNull();
    expect(properties["timezone"]).toBeNull();
    expect(properties["accuracy_radius_km"]).toBeNull();
    // The IP was valid, so the hash is populated even when the lookup
    // returned nothing.
    expect(properties["source_ip_hash"]).toBe(hashIp("8.8.8.8"));
  });

  it("does NOT leak the raw IP into any log line, even at debug level", async () => {
    const capture = new CapturingStream();
    const producer = new RecordingProducer();
    const runtime = buildRuntime(producer as unknown as PolarisProducer, {
      logLevel: "debug",
      logDestination: capture,
      newEventId: () => "evt_debug",
    });

    const payload = buildPayload(Buffer.from(JSON.stringify(SAMPLE_ENVELOPE), "utf8"));
    await runtime.handler(payload, EMPTY_CONTEXT);

    const output = capture.fullOutput();
    // Should have produced at least one log line (debug emission).
    expect(output.length).toBeGreaterThan(0);
    // The raw IP must NOT appear anywhere in the captured stream.
    expect(output).not.toContain("8.8.8.8");
    // Defence in depth: assert no IPv4 octet sequence is present.
    // This wider check protects against future refactors that might
    // accidentally bind context.ip to a logger child.
    expect(output).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/u);
    // Hash IS present.
    expect(output).toContain(hashIp("8.8.8.8"));
    expect(output).toContain("source_ip_hash");
  });

  it("does NOT leak the raw IP on the error path either", async () => {
    const capture = new CapturingStream();
    const producer = new RecordingProducer();
    producer.throwOnPublish = new Error("broker down");
    const runtime = buildRuntime(producer as unknown as PolarisProducer, {
      logLevel: "debug",
      logDestination: capture,
      newEventId: () => "evt_err",
    });

    const payload = buildPayload(Buffer.from(JSON.stringify(SAMPLE_ENVELOPE), "utf8"));
    await expect(runtime.handler(payload, EMPTY_CONTEXT)).rejects.toThrow("broker down");

    const output = capture.fullOutput();
    expect(output).not.toContain("8.8.8.8");
    expect(output).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/u);
  });

  it("emits source = 'no_ip' and null hash when context.ip is missing", async () => {
    const producer = new RecordingProducer();
    const runtime = buildRuntime(producer as unknown as PolarisProducer, {
      newEventId: () => "evt_noip",
    });

    const without = {
      ...SAMPLE_ENVELOPE,
      context: { ...SAMPLE_ENVELOPE.context, ip: null },
    };
    const payload = buildPayload(Buffer.from(JSON.stringify(without), "utf8"));
    await runtime.handler(payload, EMPTY_CONTEXT);

    expect(producer.publishes.length).toBe(1);
    const sent = producer.publishes[0];
    if (sent === undefined) throw new Error("expected one publish");
    const properties = sent.event["properties"] as Record<string, unknown>;
    expect(properties["source"]).toBe("no_ip");
    expect(properties["source_ip_hash"]).toBeNull();
    expect(properties["country_code"]).toBeNull();
  });

  it("is idempotent: replaying the same envelope yields a byte-identical properties payload", async () => {
    const producer = new RecordingProducer();
    let counter = 0;
    const runtime = buildRuntime(producer as unknown as PolarisProducer, {
      newEventId: () => `evt_${++counter}`,
    });

    const payload = buildPayload(Buffer.from(JSON.stringify(SAMPLE_ENVELOPE), "utf8"));
    await runtime.handler(payload, EMPTY_CONTEXT);
    await runtime.handler(payload, EMPTY_CONTEXT);

    expect(producer.publishes.length).toBe(2);
    const first = producer.publishes[0];
    const second = producer.publishes[1];
    if (first === undefined || second === undefined) throw new Error("expected two publishes");
    // The two emissions have DIFFERENT envelope event_ids (the runtime
    // mints a fresh UUIDv7 per emission) and same `ingested_at`/`ran_at`
    // because the clock is pinned. The `properties` block is the
    // determinism contract: every field must be identical across replays
    // so byte-identical comparison works.
    const a = JSON.stringify(first.event["properties"]);
    const b = JSON.stringify(second.event["properties"]);
    expect(a).toBe(b);
  });

  it("skips empty/tombstone messages without publishing", async () => {
    const producer = new RecordingProducer();
    const runtime = buildRuntime(producer as unknown as PolarisProducer);

    const payload = buildPayload(null);
    await runtime.handler(payload, EMPTY_CONTEXT);

    expect(producer.publishes.length).toBe(0);
  });

  it("throws when the payload is not valid JSON", async () => {
    const producer = new RecordingProducer();
    const runtime = buildRuntime(producer as unknown as PolarisProducer);

    const payload = buildPayload(Buffer.from("{not-json", "utf8"));
    await expect(runtime.handler(payload, EMPTY_CONTEXT)).rejects.toThrow();
    expect(producer.publishes.length).toBe(0);
  });

  it("throws when the decoded payload is missing required envelope fields", async () => {
    const producer = new RecordingProducer();
    const runtime = buildRuntime(producer as unknown as PolarisProducer);

    const bad = { event_id: "x", event: "y" };
    const payload = buildPayload(Buffer.from(JSON.stringify(bad), "utf8"));
    await expect(runtime.handler(payload, EMPTY_CONTEXT)).rejects.toThrow();
    expect(producer.publishes.length).toBe(0);
  });

  it("propagates producer errors so KafkaJS retries the message", async () => {
    const producer = new RecordingProducer();
    producer.throwOnPublish = new Error("broker down");
    const runtime = buildRuntime(producer as unknown as PolarisProducer);

    const payload = buildPayload(Buffer.from(JSON.stringify(SAMPLE_ENVELOPE), "utf8"));
    await expect(runtime.handler(payload, EMPTY_CONTEXT)).rejects.toThrow("broker down");
  });
});
