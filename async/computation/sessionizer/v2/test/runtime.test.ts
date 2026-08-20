/**
 * Streaming runtime tests for sessionizer v1.
 *
 * Each test drives the runtime's `handler` directly with synthesised
 * `EachMessagePayload`s. The producer slot is a recording stub so we
 * can assert which session.events were emitted, in what order, and with
 * what canonical envelope shape.
 *
 * Covers the acceptance criteria documented in
 * `docs/implementation/tasks/P8-003-sessionizer-v1.md` and the design
 * notes in the worker briefing:
 *
 *   - golden: one session.started, then continued events do not emit;
 *   - two different polaris-ids (mapped to anonymous_id) don't collide;
 *   - anonymous_id fallback when no customer_id is present;
 *   - idempotency: replaying yields the same session_id;
 *   - inactivity timeout: 31-minute gap produces ended + restart;
 *   - campaign change does not rotate the session.
 */

import { createLogger } from "@polaris/observability-logger";
import {
  deriveEventId,
  METRIC_PROCESSOR_EVENTS_SKIPPED_TOTAL,
  type ProcessorActivationGate,
  type ProcessorMetrics,
} from "@polaris/pipeline";
import {
  buildEventHeaders,
  buildRawEventsPartitionKey,
  decodeEvent,
  encodeEvent,
  type PolarisConsumer,
  type PolarisProducer,
  type PublishEventInput,
  type PublishResult,
  STREAM_FAMILY_RAW_EVENTS,
  type TransportMessageContext,
  type TransportMessagePayload,
} from "@polaris/bus";
import { describe, expect, it, vi } from "vitest";
import { createRuntime, OUTPUT_STREAM_FAMILY } from "../src/runtime.js";
import { InMemorySessionStore } from "../src/store.js";
import { PROCESSOR_NAME, PROCESSOR_VERSION } from "../src/transform.js";

const RAN_AT_ISO = "2026-05-12T12:30:00.000Z";

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

class RecordingProducer {
  public readonly publishes: Array<{
    topic: string;
    value: Buffer | string | undefined;
    key: string | undefined;
    headers: Record<string, string> | undefined;
  }> = [];
  public throwOnSend: Error | undefined;

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async publish(): Promise<PublishResult> {
    throw new Error("RecordingProducer.publish should not be called by sessionizer");
  }
  async publishToQueue(): Promise<void> {
    throw new Error("RecordingProducer.publishToQueue should not be called by sessionizer");
  }
  /**
   * `session.events` is a canonical family now, so the sessionizer goes
   * through `publishEvent` rather than the producer's low-level send.
   */
  async publishEvent(input: PublishEventInput): Promise<PublishResult> {
    if (this.throwOnSend !== undefined) {
      const err = this.throwOnSend;
      this.throwOnSend = undefined;
      throw err;
    }
    const event = input.event as unknown as Record<string, unknown>;
    this.publishes.push({
      topic: input.family,
      value: encodeEvent(event),
      key: input.partitionKey,
      headers: buildEventHeaders({
        event_id: String(event["event_id"]),
        event_name: String(event["event"]),
        schema_version: Number(event["schema_version"]),
        project_id: String(event["project_id"]),
        environment: String(event["environment"]),
        occurred_at: String(event["occurred_at"]),
        ingested_at: event["ingested_at"] as string | undefined,
        producer: "sessionizer-v1",
        topic_family: input.family,
      }) as Record<string, string>,
    });
    return { stream: `${input.family}-0`, partition: 0 };
  }

  /** Decode the i-th published payload as a JSON object. */
  decoded(index: number): Record<string, unknown> {
    const entry = this.publishes[index];
    if (entry === undefined) throw new Error(`no publish at index ${index}`);
    if (entry.value === undefined) throw new Error("publish had no value");
    if (typeof entry.value === "string") {
      return JSON.parse(entry.value) as Record<string, unknown>;
    }
    return decodeEvent(entry.value) as Record<string, unknown>;
  }
}

function stubConsumer(): PolarisConsumer {
  return {
    disconnect: vi.fn(async () => {}),
    subscribe: vi.fn(async () => {}),
    runEach: vi.fn(async () => {}),
    streams: [],
    queues: [],
  };
}

interface BuildOptions {
  readonly producer: RecordingProducer;
  readonly store?: InMemorySessionStore;
  readonly run_id?: string;
  readonly newEventId?: () => string;
  /** Activation gate under test. */
  readonly gate?: ProcessorActivationGate;
}

function buildRuntime(options: BuildOptions) {
  const logger = createLogger({ service: "test", version: "0.0.0", env: "local" });
  const store = options.store ?? new InMemorySessionStore();
  return {
    runtime: createRuntime({
      consumer: stubConsumer(),
      producer: options.producer as unknown as PolarisProducer,
      store,
      logger,
      now: () => new Date(RAN_AT_ISO),
      run_id: options.run_id ?? "run_test_1",
      newEventId: options.newEventId ?? deterministicEventIds(),
      ...(options.gate !== undefined ? { gate: options.gate } : {}),
    }),
    store,
  };
}

/** Build a deterministic UUIDv7-shaped allocator. */
function deterministicEventIds(): () => string {
  let counter = 0;
  return (): string => {
    counter += 1;
    const padded = counter.toString().padStart(12, "0");
    return `018f1b9e-9999-7b12-9a2e-${padded}`;
  };
}

function buildRawEnvelopeJson(overrides: {
  readonly event_id?: string;
  readonly occurred_at?: string;
  readonly project_id?: string;
  readonly environment?: string;
  readonly identity?: Partial<Record<string, string | null>>;
  readonly context?: Record<string, unknown>;
  /** The person. `null` models an event identity could not resolve. */
  readonly profile_id?: string | null;
}): Buffer {
  const identity = {
    anonymous_id: null,
    session_id: null,
    customer_id: null,
    device_id: null,
    ...overrides.identity,
  };
  const envelope = {
    event_id: overrides.event_id ?? "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
    event: "page.viewed",
    schema_version: 2,
    project_id: overrides.project_id ?? "checkout",
    environment: overrides.environment ?? "production",
    occurred_at: overrides.occurred_at ?? "2026-05-12T12:00:00.000Z",
    ingested_at: "2026-05-12T12:00:01.000Z",
    source: { type: "browser", id: "web", sdk: "web", sdk_version: "1.0.0" },
    identity,
    profile:
      overrides.profile_id === null
        ? null
        : {
            profile_id: overrides.profile_id ?? "01a00000-0000-7000-8000-00000000f001",
            canonical_customer_id: null,
          },
    context: overrides.context ?? {
      ip: null,
      user_agent: null,
      locale: null,
      page: null,
      campaign: null,
    },
    properties: { path: "/", search: null, title: "Home", referrer: null },
  };
  return Buffer.from(JSON.stringify(envelope), "utf8");
}

const EMPTY_CONTEXT: TransportMessageContext = {};

describe("sessionizer runtime", () => {
  it("emits session.started on the first event and continues without emitting on subsequent in-window events", async () => {
    const producer = new RecordingProducer();
    const { runtime, store } = buildRuntime({ producer });

    // Event 1: opens a new session for the person.
    await runtime.handler(
      buildPayload(
        buildRawEnvelopeJson({
          event_id: "evt-1",
          identity: { anonymous_id: "anon_X" },
          occurred_at: "2026-05-12T12:00:00.000Z",
        }),
      ),
      EMPTY_CONTEXT,
    );
    expect(producer.publishes).toHaveLength(1);
    expect(producer.publishes[0]?.topic).toBe(OUTPUT_STREAM_FAMILY);
    const started = producer.decoded(0);
    expect(started["event"]).toBe("session.started");
    expect(started["schema_version"]).toBe(1);
    expect(started["processor_name"]).toBe(PROCESSOR_NAME);
    expect(started["processor_version"]).toBe(PROCESSOR_VERSION);
    const props = started["properties"] as Record<string, unknown>;
    expect(props["primary_identifier_kind"]).toBe("profile_id");
    expect(props["primary_identifier_value"]).toBe("01a00000-0000-7000-8000-00000000f001");
    expect(props["started_at"]).toBe("2026-05-12T12:00:00.000Z");
    expect(props["session_id"]).toMatch(/^sess_[0-9a-f]+$/u);
    expect(props["source_event_id"]).toBe("evt-1");
    expect(props["run_id"]).toBe("run_test_1");

    // Event 2: 5 minutes later, same anonymous_id — should continue without emission.
    await runtime.handler(
      buildPayload(
        buildRawEnvelopeJson({
          event_id: "evt-2",
          identity: { anonymous_id: "anon_X" },
          occurred_at: "2026-05-12T12:05:00.000Z",
        }),
      ),
      EMPTY_CONTEXT,
    );
    expect(producer.publishes).toHaveLength(1);

    // Event 3: 29 minutes after event 2 — still inside the window.
    await runtime.handler(
      buildPayload(
        buildRawEnvelopeJson({
          event_id: "evt-3",
          identity: { anonymous_id: "anon_X" },
          occurred_at: "2026-05-12T12:34:00.000Z",
        }),
      ),
      EMPTY_CONTEXT,
    );
    expect(producer.publishes).toHaveLength(1);

    // Store snapshot reflects three observations.
    const snap = store.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]?.event_count).toBe(3);
    expect(snap[0]?.last_seen_at).toBe("2026-05-12T12:34:00.000Z");
  });

  it("two different people do not collide", async () => {
    const producer = new RecordingProducer();
    const { runtime, store } = buildRuntime({ producer });

    await runtime.handler(
      buildPayload(
        buildRawEnvelopeJson({
          event_id: "evt-A1",
          identity: { anonymous_id: "anon_A" },
          profile_id: "01a00000-0000-7000-8000-00000000f001",
          occurred_at: "2026-05-12T12:00:00.000Z",
        }),
      ),
      EMPTY_CONTEXT,
    );
    await runtime.handler(
      buildPayload(
        buildRawEnvelopeJson({
          event_id: "evt-B1",
          identity: { anonymous_id: "anon_B" },
          profile_id: "01a00000-0000-7000-8000-00000000f002",
          occurred_at: "2026-05-12T12:01:00.000Z",
        }),
      ),
      EMPTY_CONTEXT,
    );

    expect(producer.publishes).toHaveLength(2);
    const startedA = producer.decoded(0);
    const startedB = producer.decoded(1);
    const propsA = startedA["properties"] as Record<string, unknown>;
    const propsB = startedB["properties"] as Record<string, unknown>;
    expect(propsA["session_id"]).not.toBe(propsB["session_id"]);
    expect(propsA["primary_identifier_value"]).toBe("01a00000-0000-7000-8000-00000000f001");
    expect(propsB["primary_identifier_value"]).toBe("01a00000-0000-7000-8000-00000000f002");
    expect(store.snapshot()).toHaveLength(2);
  });

  it("keys on the person even when the event carries no customer_id", async () => {
    const producer = new RecordingProducer();
    const { runtime } = buildRuntime({ producer });

    await runtime.handler(
      buildPayload(
        buildRawEnvelopeJson({
          event_id: "evt-anon",
          // Explicitly no customer_id; only anonymous_id is set.
          identity: { anonymous_id: "anon_X", customer_id: null },
          occurred_at: "2026-05-12T12:00:00.000Z",
        }),
      ),
      EMPTY_CONTEXT,
    );
    expect(producer.publishes).toHaveLength(1);
    const started = producer.decoded(0);
    const props = started["properties"] as Record<string, unknown>;
    expect(props["primary_identifier_kind"]).toBe("profile_id");
    expect(props["primary_identifier_value"]).toBe("01a00000-0000-7000-8000-00000000f001");
  });

  it("emits session.ended then session.started on a 31-minute inactivity gap", async () => {
    const producer = new RecordingProducer();
    const { runtime, store } = buildRuntime({ producer });

    await runtime.handler(
      buildPayload(
        buildRawEnvelopeJson({
          event_id: "evt-1",
          identity: { anonymous_id: "anon_X" },
          occurred_at: "2026-05-12T12:00:00.000Z",
        }),
      ),
      EMPTY_CONTEXT,
    );
    expect(producer.publishes).toHaveLength(1);
    const firstStarted = producer.decoded(0);
    const firstSessionId = (firstStarted["properties"] as Record<string, unknown>)["session_id"];

    // 31 minutes after the first event — past the 30 min boundary.
    await runtime.handler(
      buildPayload(
        buildRawEnvelopeJson({
          event_id: "evt-2",
          identity: { anonymous_id: "anon_X" },
          occurred_at: "2026-05-12T12:31:00.000Z",
        }),
      ),
      EMPTY_CONTEXT,
    );
    // ended + started
    expect(producer.publishes).toHaveLength(3);
    const ended = producer.decoded(1);
    const restarted = producer.decoded(2);
    expect(ended["event"]).toBe("session.ended");
    expect(restarted["event"]).toBe("session.started");

    const endedProps = ended["properties"] as Record<string, unknown>;
    expect(endedProps["session_id"]).toBe(firstSessionId);
    expect(endedProps["inactivity_seconds"]).toBe(1800);
    expect(endedProps["event_count"]).toBe(1);
    // ended_at is anchored to last_seen + 1800s, NOT the moment of detection.
    expect(endedProps["ended_at"]).toBe("2026-05-12T12:30:00.000Z");
    // session.ended.occurred_at mirrors ended_at.
    expect(ended["occurred_at"]).toBe("2026-05-12T12:30:00.000Z");

    const restartProps = restarted["properties"] as Record<string, unknown>;
    expect(restartProps["session_id"]).not.toBe(firstSessionId);
    expect(restartProps["started_at"]).toBe("2026-05-12T12:31:00.000Z");

    // Only one active session in the store after the restart.
    expect(store.size()).toBe(1);
    expect(store.snapshot()[0]?.session_id).toBe(restartProps["session_id"]);
  });

  it("idempotency: replaying the same raw events produces the same session_id", async () => {
    const producerA = new RecordingProducer();
    const producerB = new RecordingProducer();
    // Same deterministic event_id allocator both times so the comparison
    // covers session_id specifically.
    const { runtime: runtimeA } = buildRuntime({
      producer: producerA,
      newEventId: deterministicEventIds(),
    });
    const { runtime: runtimeB } = buildRuntime({
      producer: producerB,
      newEventId: deterministicEventIds(),
    });

    const payload = buildRawEnvelopeJson({
      event_id: "evt-x",
      identity: { anonymous_id: "anon_X" },
      occurred_at: "2026-05-12T12:00:00.000Z",
    });
    await runtimeA.handler(buildPayload(payload), EMPTY_CONTEXT);
    await runtimeB.handler(buildPayload(payload), EMPTY_CONTEXT);

    const a = producerA.decoded(0);
    const b = producerB.decoded(0);
    expect((a["properties"] as Record<string, unknown>)["session_id"]).toBe(
      (b["properties"] as Record<string, unknown>)["session_id"],
    );
  });

  it("campaign change does NOT rotate the sessionizer's session (campaign is context)", async () => {
    const producer = new RecordingProducer();
    const { runtime } = buildRuntime({ producer });

    await runtime.handler(
      buildPayload(
        buildRawEnvelopeJson({
          event_id: "evt-1",
          identity: { anonymous_id: "anon_X" },
          occurred_at: "2026-05-12T12:00:00.000Z",
          context: {
            ip: null,
            user_agent: null,
            locale: null,
            page: null,
            campaign: { utm_source: "google", utm_medium: "cpc" },
          },
        }),
      ),
      EMPTY_CONTEXT,
    );
    // Campaign change a few minutes later (same anonymous_id) — must not
    // rotate the sessionizer's session.
    await runtime.handler(
      buildPayload(
        buildRawEnvelopeJson({
          event_id: "evt-2",
          identity: { anonymous_id: "anon_X" },
          occurred_at: "2026-05-12T12:05:00.000Z",
          context: {
            ip: null,
            user_agent: null,
            locale: null,
            page: null,
            campaign: { utm_source: "facebook", utm_medium: "social" },
          },
        }),
      ),
      EMPTY_CONTEXT,
    );

    // Only the original session.started was emitted; no new start, no end.
    expect(producer.publishes).toHaveLength(1);
    expect(producer.decoded(0)["event"]).toBe("session.started");
  });

  it("emitted envelope passes a structural envelope sanity check", async () => {
    const producer = new RecordingProducer();
    const { runtime } = buildRuntime({ producer });

    await runtime.handler(
      buildPayload(
        buildRawEnvelopeJson({
          event_id: "evt-1",
          identity: { anonymous_id: "anon_X" },
          occurred_at: "2026-05-12T12:00:00.000Z",
        }),
      ),
      EMPTY_CONTEXT,
    );
    const emitted = producer.decoded(0);
    expect(emitted["source"]).toEqual({
      type: "internal",
      id: PROCESSOR_NAME,
      sdk: null,
      sdk_version: null,
    });
    expect(emitted["context"]).toEqual({
      ip: null,
      user_agent: null,
      locale: null,
      page: null,
      campaign: null,
    });
    expect(emitted["processor"]).toEqual({
      name: PROCESSOR_NAME,
      version: PROCESSOR_VERSION,
      ran_at: RAN_AT_ISO,
      run_id: "run_test_1",
    });
    // The identity layer mirrors the source raw event's identity block.
    expect(emitted["identity"]).toEqual({
      anonymous_id: "anon_X",
      session_id: null,
      customer_id: null,
      device_id: null,
    });
  });

  it("uses the canonical raw.events partition key on the emitted record", async () => {
    const producer = new RecordingProducer();
    const { runtime } = buildRuntime({ producer });
    const occurredAt = "2026-05-12T12:00:00.000Z";
    await runtime.handler(
      buildPayload(
        buildRawEnvelopeJson({
          event_id: "evt-1",
          identity: { anonymous_id: "anon_X" },
          occurred_at: occurredAt,
        }),
      ),
      EMPTY_CONTEXT,
    );
    const sent = producer.publishes[0];
    if (sent === undefined) throw new Error("expected publish");
    const emitted = producer.decoded(0);
    const expected = buildRawEventsPartitionKey({
      project_id: emitted["project_id"] as string,
      environment: emitted["environment"] as string,
      event_id: emitted["event_id"] as string,
      identity: emitted["identity"] as never,
    });
    expect(sent.key).toBe(expected);
  });

  it("drops an event the identity stage could not resolve, without emitting", async () => {
    const producer = new RecordingProducer();
    const { runtime, store } = buildRuntime({ producer });

    await runtime.handler(
      buildPayload(
        buildRawEnvelopeJson({
          event_id: "evt-1",
          profile_id: null, // the identity stage resolved nobody
          occurred_at: "2026-05-12T12:00:00.000Z",
        }),
      ),
      EMPTY_CONTEXT,
    );
    expect(producer.publishes).toHaveLength(0);
    expect(store.size()).toBe(0);
  });

  it("keeps ONE session across a login — the reason this version exists", async () => {
    // THE regression v2 was cut for. In v1 a visitor browsing
    // anonymously keyed on `anonymous_id`; the moment they logged in the
    // same person keyed on `customer_id`, so the pre-login window was
    // orphaned — it expired unclosed against a key nobody would touch
    // again — and a second session opened for someone who never left.
    // Every funnel spanning a login measured two sessions.
    //
    // The identity stage resolves both events to one profile now, so the
    // key never changes.
    const producer = new RecordingProducer();
    const { runtime, store } = buildRuntime({ producer });

    // Anonymous browsing.
    await runtime.handler(
      buildPayload(
        buildRawEnvelopeJson({
          event_id: "evt-anon",
          identity: { anonymous_id: "anon_X" },
          occurred_at: "2026-05-12T12:00:00.000Z",
          profile_id: "01a00000-0000-7000-8000-00000000f001",
        }),
      ),
      EMPTY_CONTEXT,
    );

    // The login: same person, and the event now carries a customer_id
    // too — which under v1 would have switched the key.
    await runtime.handler(
      buildPayload(
        buildRawEnvelopeJson({
          event_id: "evt-login",
          identity: { anonymous_id: "anon_X", customer_id: "cus_1" },
          occurred_at: "2026-05-12T12:05:00.000Z",
          profile_id: "01a00000-0000-7000-8000-00000000f001",
        }),
      ),
      EMPTY_CONTEXT,
    );

    // More browsing, now known.
    await runtime.handler(
      buildPayload(
        buildRawEnvelopeJson({
          event_id: "evt-known",
          identity: { anonymous_id: "anon_X", customer_id: "cus_1" },
          occurred_at: "2026-05-12T12:10:00.000Z",
          profile_id: "01a00000-0000-7000-8000-00000000f001",
        }),
      ),
      EMPTY_CONTEXT,
    );

    // One session.started, nothing ended.
    const names = producer.publishes.map((_publish, index) => producer.decoded(index)["event"]);
    expect(names).toEqual(["session.started"]);

    // And one live window — no orphan under a key nobody will touch.
    expect(store.size()).toBe(1);
  });

  it("skips tombstone (null value) messages", async () => {
    const producer = new RecordingProducer();
    const { runtime } = buildRuntime({ producer });
    await runtime.handler(buildPayload(null), EMPTY_CONTEXT);
    expect(producer.publishes).toHaveLength(0);
  });

  it("throws on undecodable JSON so KafkaJS surfaces the failure", async () => {
    const producer = new RecordingProducer();
    const { runtime } = buildRuntime({ producer });
    await expect(
      runtime.handler(buildPayload(Buffer.from("{not-json", "utf8")), EMPTY_CONTEXT),
    ).rejects.toThrow();
    expect(producer.publishes).toHaveLength(0);
  });

  it("throws when the payload is missing required envelope fields", async () => {
    const producer = new RecordingProducer();
    const { runtime } = buildRuntime({ producer });
    const bad = Buffer.from(JSON.stringify({ event_id: "x" }), "utf8");
    await expect(runtime.handler(buildPayload(bad), EMPTY_CONTEXT)).rejects.toThrow();
  });
});

describe("createRuntime activation gate (sessionizer v1)", () => {
  it("emits nothing for a scope an operator disabled", async () => {
    const producer = new RecordingProducer();
    const { runtime } = buildRuntime({
      producer,
      gate: gateDisabling({ project_id: "checkout", environment: "production" }),
    });

    await runtime.handler(
      buildPayload(buildRawEnvelopeJson({ identity: { anonymous_id: "anon_X" } })),
      EMPTY_CONTEXT,
    );

    expect(producer.publishes.length).toBe(0);
    expect(skippedTotal(runtime.metrics)).toBe(1);
  });

  it("keeps sessionizing scopes the disable does not name", async () => {
    const producer = new RecordingProducer();
    const { runtime } = buildRuntime({
      producer,
      gate: gateDisabling({ project_id: "checkout", environment: "development" }),
    });

    await runtime.handler(
      buildPayload(buildRawEnvelopeJson({ identity: { anonymous_id: "anon_X" } })),
      EMPTY_CONTEXT,
    );

    expect(producer.publishes.length).toBeGreaterThan(0);
    expect(skippedTotal(runtime.metrics)).toBe(0);
  });
});

/** Gate that refuses exactly one (project, environment). */
function gateDisabling(scope: {
  project_id: string;
  environment: string;
}): ProcessorActivationGate {
  return {
    isEnabled: async (asked) =>
      !(asked.project_id === scope.project_id && asked.environment === scope.environment),
  };
}

function skippedTotal(metrics: ProcessorMetrics): number {
  return metrics
    .getSamples()
    .filter((sample) => sample.name === METRIC_PROCESSOR_EVENTS_SKIPPED_TOTAL)
    .reduce((total, sample) => total + sample.value, 0);
}

describe("createRuntime derived event ids (sessionizer v1)", () => {
  it("reproduces the same event_id when the same source event is redelivered", () => {
    // At-least-once means this happens routinely: a rewind, a crash replay, a
    // checkpoint that did not land. Each attempt used to mint a fresh uuidv7,
    // so `analytics_processed` — ReplacingMergeTree keyed on event_id —
    // accumulated the retries as separate facts instead of collapsing them.
    const first = deriveEventId({
      processor: PROCESSOR_NAME,
      sourceEventId: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
      slot: "started",
    });
    const second = deriveEventId({
      processor: PROCESSOR_NAME,
      sourceEventId: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
      slot: "started",
    });
    expect(second).toBe(first);
  });

  it("emits a derived id, not a random one, when no allocator is injected", async () => {
    // The production path: `newEventId` unset. Two runs over the same input
    // must agree, which a uuidv7 default could never do.
    async function emitOnce(): Promise<string> {
      const producer = new RecordingProducer();
      // createRuntime directly, NOT buildRuntime: the helper always injects a
      // deterministic counter, which would make this pass without exercising
      // the derivation at all.
      const runtime = createRuntime({
        consumer: stubConsumer(),
        producer: producer as unknown as PolarisProducer,
        store: new InMemorySessionStore(),
        logger: createLogger({ service: "test", version: "0.0.0", env: "local" }),
        now: () => new Date(RAN_AT_ISO),
        run_id: "run_test_1",
        inactivity_seconds: 1800,
      });
      await runtime.handler(
        buildPayload(buildRawEnvelopeJson({ identity: { anonymous_id: "anon_X" } })),
        EMPTY_CONTEXT,
      );
      // The recorder keeps the encoded envelope, and the id is also on the
      // header the transport stamps — read the headers, which is what a
      // consumer would key on.
      const headers = producer.publishes[0]?.headers ?? {};
      return String(headers["polaris-event-id"] ?? headers["x-polaris-event-id"] ?? "");
    }
    const first = await emitOnce();
    // Fail loudly rather than comparing two empty strings.
    expect(first).toMatch(/^[0-9a-f-]{36}$/i);
    expect(await emitOnce()).toBe(first);
  });
});
