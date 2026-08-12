/**
 * Streaming runtime tests for attribution-engine v2.
 *
 * Each test drives the runtime's `handler` directly with synthesised
 * `TransportMessagePayload`s. The producer slot is a recording stub so we can
 * assert which attribution events were emitted, in what order, and with
 * what canonical envelope shape.
 *
 * Covers the acceptance criteria in
 * `docs/implementation/tasks/P8-005-attribution-engine-v1.md`:
 *   - deterministic attribution fixtures exist;
 *   - vendor-specific destination logic is absent (click_id is a single
 *     catch-all field; no `gclid` / `fbclid` splits);
 *   - output events include processor metadata.
 */

import { createLogger } from "@polaris/shared-logger";
import {
  METRIC_PROCESSOR_EVENTS_SKIPPED_TOTAL,
  type ProcessorActivationGate,
  type ProcessorMetrics,
} from "@polaris/shared-processor";
import {
  decodeEvent,
  type PolarisConsumer,
  type PolarisProducer,
  type PublishEventInput,
  type PublishResult,
  STREAM_FAMILY_ATTRIBUTION_EVENTS,
  STREAM_FAMILY_RAW_EVENTS,
  type TransportMessageContext,
  type TransportMessagePayload,
} from "@polaris/shared-transport";
import { describe, expect, it, vi } from "vitest";
import { createRuntime } from "../src/runtime.js";
import { InMemoryTouchpointStore } from "../src/store.js";
import { PROCESSOR_NAME, PROCESSOR_VERSION } from "../src/transform.js";

const NOW_ISO = "2026-05-14T12:30:00.000Z";

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

function buildContext(overrides: Partial<TransportMessageContext> = {}): TransportMessageContext {
  return {
    receivedAt: new Date(NOW_ISO),
    ...overrides,
  } as TransportMessageContext;
}

class RecordingProducer {
  public readonly publishes: Array<{
    family: string;
    payload: Record<string, unknown>;
  }> = [];
  public throwOnPublish: Error | undefined;

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async publishEvent(input: PublishEventInput): Promise<PublishResult> {
    if (this.throwOnPublish !== undefined) {
      const err = this.throwOnPublish;
      this.throwOnPublish = undefined;
      throw err;
    }
    this.publishes.push({
      family: input.family,
      payload: input.event as Record<string, unknown>,
    });
    return { stream: `${input.family}-0`, partition: 0 };
  }

  async publish(): Promise<PublishResult> {
    throw new Error("RecordingProducer.publish should not be called by attribution-engine");
  }

  async publishToQueue(): Promise<void> {
    throw new Error("RecordingProducer.publishToQueue should not be called by attribution-engine");
  }
}

function stubConsumer(): PolarisConsumer {
  return {
    disconnect: vi.fn(async () => {}),
    subscribe: vi.fn(async () => {}),
    runEach: vi.fn(async () => {}),
    streams: [],
    queues: [],
  } as unknown as PolarisConsumer;
}

interface AnalyticsEnvelopeOverrides {
  readonly event_id?: string;
  readonly occurred_at?: string;
  readonly project_id?: string;
  readonly environment?: string;
  readonly anonymous_id?: string | null;
  readonly session_id?: string | null;
  readonly customer_id?: string | null;
  readonly campaign?: Record<string, string | null> | null;
}

function encodeEnvelope(overrides: AnalyticsEnvelopeOverrides = {}): Buffer {
  const identity = {
    anonymous_id: overrides.anonymous_id ?? null,
    session_id: overrides.session_id ?? null,
    customer_id: overrides.customer_id ?? null,
    device_id: null,
  };
  const envelope = {
    event_id: overrides.event_id ?? "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
    event: "page.viewed",
    schema_version: 1,
    project_id: overrides.project_id ?? "checkout",
    environment: overrides.environment ?? "production",
    occurred_at: overrides.occurred_at ?? "2026-05-14T12:00:00.000Z",
    ingested_at: "2026-05-14T12:00:01.000Z",
    source: {
      type: "browser",
      id: "web",
      sdk: "web",
      sdk_version: "1.0.0",
    },
    identity,
    context: {
      ip: null,
      user_agent: null,
      locale: null,
      page: null,
      campaign: overrides.campaign === undefined ? null : overrides.campaign,
    },
    properties: {},
    processor: {
      name: "analytics-projector",
      version: "v2",
      ran_at: "2026-05-14T12:00:01.250Z",
    },
    processor_name: "analytics-projector",
    processor_version: "v2",
  };
  return Buffer.from(JSON.stringify(envelope), "utf8");
}

function buildRuntime(
  opts: {
    readonly store?: InMemoryTouchpointStore;
    readonly producer?: RecordingProducer;
    readonly run_id?: string;
    readonly gate?: ProcessorActivationGate;
  } = {},
) {
  const store = opts.store ?? new InMemoryTouchpointStore();
  const producer = opts.producer ?? new RecordingProducer();
  const consumer = stubConsumer();
  const logger = createLogger({
    service: "attribution-engine-test",
    env: "test",
    version: "0.0.0",
  });
  let counter = 0;
  const runtime = createRuntime({
    consumer,
    producer: producer as unknown as PolarisProducer,
    store,
    logger,
    now: () => new Date(NOW_ISO),
    newEventId: () => `evt_emitted_${++counter}`,
    run_id: opts.run_id ?? "run_test_1",
    ...(opts.gate !== undefined ? { gate: opts.gate } : {}),
  });
  return { runtime, producer, store, consumer };
}

const FULL_CAMPAIGN = {
  source: "google",
  medium: "cpc",
  name: "summer_sale_2026",
  term: null,
  content: null,
  click_id: "gclid_abc123",
};

const ALT_CAMPAIGN = {
  source: "facebook",
  medium: "social",
  name: "summer_sale_2026",
  term: null,
  content: null,
  click_id: "fbclid_xyz",
};

describe("attribution-engine runtime — golden first observation", () => {
  it("emits touchpoint_captured + first_touch_assigned + last_touch_assigned in that order", async () => {
    const { runtime, producer } = buildRuntime();
    const payload = buildPayload(
      encodeEnvelope({
        event_id: "evt_first",
        anonymous_id: "anon_X",
        campaign: FULL_CAMPAIGN,
      }),
    );
    await runtime.handler(payload, buildContext());

    expect(producer.publishes).toHaveLength(3);

    const events = producer.publishes.map((p) => (p.payload as { event: string }).event);
    expect(events).toEqual([
      "attribution.touchpoint_captured",
      "attribution.first_touch_assigned",
      "attribution.last_touch_assigned",
    ]);
    // Every publish targets the attribution.events topic family.
    for (const pub of producer.publishes) {
      expect(pub.family).toBe(STREAM_FAMILY_ATTRIBUTION_EVENTS);
    }
  });

  it("stamps the processor identity in both nested + flat shapes on every emission", async () => {
    const { runtime, producer } = buildRuntime();
    const payload = buildPayload(
      encodeEnvelope({
        event_id: "evt_first",
        anonymous_id: "anon_X",
        campaign: FULL_CAMPAIGN,
      }),
    );
    await runtime.handler(payload, buildContext());

    for (const pub of producer.publishes) {
      const env = pub.payload as Record<string, unknown> & {
        readonly processor: { name: string; version: string; ran_at: string; run_id?: string };
        readonly processor_name: string;
        readonly processor_version: string;
      };
      expect(env.processor_name).toBe(PROCESSOR_NAME);
      expect(env.processor_version).toBe(PROCESSOR_VERSION);
      expect(env.processor.name).toBe(PROCESSOR_NAME);
      expect(env.processor.version).toBe(PROCESSOR_VERSION);
      expect(env.processor.run_id).toBe("run_test_1");
    }
  });

  it("the touchpoint_captured event shares its touchpoint_id with the first/last emissions", async () => {
    const { runtime, producer } = buildRuntime();
    const payload = buildPayload(
      encodeEnvelope({
        event_id: "evt_first",
        anonymous_id: "anon_X",
        campaign: FULL_CAMPAIGN,
      }),
    );
    await runtime.handler(payload, buildContext());

    const props = producer.publishes.map(
      (p) => (p.payload as { properties: { touchpoint_id: string } }).properties.touchpoint_id,
    );
    expect(new Set(props).size).toBe(1);
    expect(props[0]).toMatch(/^tp_[0-9a-f]+$/u);
  });
});

describe("attribution-engine runtime — same-tuple repeat (idempotent delta detection)", () => {
  it("emits only touchpoint_captured on a same-tuple repeat", async () => {
    const store = new InMemoryTouchpointStore();
    const { runtime, producer } = buildRuntime({ store });

    // First observation: full chain emits.
    await runtime.handler(
      buildPayload(
        encodeEnvelope({
          event_id: "evt_first",
          anonymous_id: "anon_X",
          campaign: FULL_CAMPAIGN,
        }),
      ),
      buildContext(),
    );
    expect(producer.publishes).toHaveLength(3);

    // Same campaign, different event id: only touchpoint_captured emits.
    await runtime.handler(
      buildPayload(
        encodeEnvelope({
          event_id: "evt_repeat",
          anonymous_id: "anon_X",
          campaign: FULL_CAMPAIGN,
        }),
      ),
      buildContext(),
    );
    expect(producer.publishes).toHaveLength(4);
    const repeatEvent = (producer.publishes[3]?.payload as { event: string }).event;
    expect(repeatEvent).toBe("attribution.touchpoint_captured");
  });

  it("bumps the in-memory store's touchpoint_count on each repeat", async () => {
    const store = new InMemoryTouchpointStore();
    const { runtime } = buildRuntime({ store });

    await runtime.handler(
      buildPayload(
        encodeEnvelope({
          event_id: "evt_first",
          anonymous_id: "anon_X",
          campaign: FULL_CAMPAIGN,
        }),
      ),
      buildContext(),
    );
    await runtime.handler(
      buildPayload(
        encodeEnvelope({
          event_id: "evt_2",
          anonymous_id: "anon_X",
          campaign: FULL_CAMPAIGN,
        }),
      ),
      buildContext(),
    );
    await runtime.handler(
      buildPayload(
        encodeEnvelope({
          event_id: "evt_3",
          anonymous_id: "anon_X",
          campaign: FULL_CAMPAIGN,
        }),
      ),
      buildContext(),
    );

    const snapshot = store.snapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.touchpoint_count).toBe(3);
  });
});

describe("attribution-engine runtime — last-touch delta", () => {
  it("emits touchpoint_captured + last_touch_assigned (NO first_touch_assigned) when the campaign tuple changes", async () => {
    const store = new InMemoryTouchpointStore();
    const { runtime, producer } = buildRuntime({ store });

    // Seed: first observation.
    await runtime.handler(
      buildPayload(
        encodeEnvelope({
          event_id: "evt_first",
          anonymous_id: "anon_X",
          campaign: FULL_CAMPAIGN,
        }),
      ),
      buildContext(),
    );
    expect(producer.publishes).toHaveLength(3);

    // Delta: different campaign.
    await runtime.handler(
      buildPayload(
        encodeEnvelope({
          event_id: "evt_delta",
          anonymous_id: "anon_X",
          campaign: ALT_CAMPAIGN,
        }),
      ),
      buildContext(),
    );
    expect(producer.publishes).toHaveLength(5);
    const deltaEvents = producer.publishes
      .slice(3)
      .map((p) => (p.payload as { event: string }).event);
    expect(deltaEvents).toEqual([
      "attribution.touchpoint_captured",
      "attribution.last_touch_assigned",
    ]);
  });

  it("records previous_touchpoint_id on the new last_touch_assigned event", async () => {
    const store = new InMemoryTouchpointStore();
    const { runtime, producer } = buildRuntime({ store });

    await runtime.handler(
      buildPayload(
        encodeEnvelope({
          event_id: "evt_first",
          anonymous_id: "anon_X",
          campaign: FULL_CAMPAIGN,
        }),
      ),
      buildContext(),
    );
    const firstLast = producer.publishes[2]?.payload as {
      properties: { touchpoint_id: string };
    };
    const firstTouchpointId = firstLast.properties.touchpoint_id;

    await runtime.handler(
      buildPayload(
        encodeEnvelope({
          event_id: "evt_delta",
          anonymous_id: "anon_X",
          campaign: ALT_CAMPAIGN,
        }),
      ),
      buildContext(),
    );

    const deltaLast = producer.publishes[4]?.payload as {
      properties: { previous_touchpoint_id: string | null; touchpoint_id: string };
    };
    expect(deltaLast.properties.previous_touchpoint_id).toBe(firstTouchpointId);
    expect(deltaLast.properties.touchpoint_id).not.toBe(firstTouchpointId);
  });
});

describe("attribution-engine runtime — drop branches", () => {
  it("drops events with no usable identifier (no emission)", async () => {
    const { runtime, producer } = buildRuntime();
    await runtime.handler(
      buildPayload(
        encodeEnvelope({
          event_id: "evt_no_id",
          // identity: all null.
          campaign: FULL_CAMPAIGN,
        }),
      ),
      buildContext(),
    );
    expect(producer.publishes).toHaveLength(0);
  });

  it("drops events with no campaign signal (no emission)", async () => {
    const { runtime, producer } = buildRuntime();
    await runtime.handler(
      buildPayload(
        encodeEnvelope({
          event_id: "evt_no_campaign",
          anonymous_id: "anon_X",
          campaign: null,
        }),
      ),
      buildContext(),
    );
    expect(producer.publishes).toHaveLength(0);
  });

  it("drops events whose campaign block has only empty-string fields", async () => {
    const { runtime, producer } = buildRuntime();
    await runtime.handler(
      buildPayload(
        encodeEnvelope({
          event_id: "evt_empty_campaign",
          anonymous_id: "anon_X",
          campaign: {
            source: "",
            medium: "",
            name: "",
            term: "",
            content: "",
            click_id: "",
          },
        }),
      ),
      buildContext(),
    );
    expect(producer.publishes).toHaveLength(0);
  });

  it("skips tombstone-style empty payloads with a warn log", async () => {
    const { runtime, producer } = buildRuntime();
    await runtime.handler(buildPayload(null), buildContext());
    expect(producer.publishes).toHaveLength(0);
  });
});

describe("attribution-engine runtime — identifier isolation", () => {
  it("keeps two different anonymous_id values isolated", async () => {
    const store = new InMemoryTouchpointStore();
    const { runtime, producer } = buildRuntime({ store });
    await runtime.handler(
      buildPayload(
        encodeEnvelope({
          event_id: "evt_a",
          anonymous_id: "anon_A",
          campaign: FULL_CAMPAIGN,
        }),
      ),
      buildContext(),
    );
    await runtime.handler(
      buildPayload(
        encodeEnvelope({
          event_id: "evt_b",
          anonymous_id: "anon_B",
          campaign: FULL_CAMPAIGN,
        }),
      ),
      buildContext(),
    );
    // Two identifiers, both first-observation: 6 emissions total.
    expect(producer.publishes).toHaveLength(6);
    expect(store.size()).toBe(2);
  });

  it("scopes attribution by (project_id, environment) — same identifier across projects is two chains", async () => {
    const store = new InMemoryTouchpointStore();
    const { runtime, producer } = buildRuntime({ store });
    await runtime.handler(
      buildPayload(
        encodeEnvelope({
          event_id: "evt_proj_a",
          project_id: "checkout",
          anonymous_id: "anon_X",
          campaign: FULL_CAMPAIGN,
        }),
      ),
      buildContext(),
    );
    await runtime.handler(
      buildPayload(
        encodeEnvelope({
          event_id: "evt_proj_b",
          project_id: "support",
          anonymous_id: "anon_X",
          campaign: FULL_CAMPAIGN,
        }),
      ),
      buildContext(),
    );
    expect(producer.publishes).toHaveLength(6);
    expect(store.size()).toBe(2);
  });
});

describe("attribution-engine runtime — vendor-neutrality", () => {
  it("treats click_id as a single catch-all field (no gclid/fbclid splitting)", async () => {
    const { runtime, producer } = buildRuntime();
    await runtime.handler(
      buildPayload(
        encodeEnvelope({
          event_id: "evt_click",
          anonymous_id: "anon_X",
          campaign: {
            source: "google",
            medium: "cpc",
            name: null,
            term: null,
            content: null,
            click_id: "gclid_value",
          },
        }),
      ),
      buildContext(),
    );
    const touchpoint = producer.publishes[0]?.payload as {
      properties: { campaign: Record<string, unknown> };
    };
    // The campaign block contains exactly the six canonical fields.
    expect(Object.keys(touchpoint.properties.campaign).sort()).toEqual([
      "click_id",
      "content",
      "medium",
      "name",
      "source",
      "term",
    ]);
    expect(touchpoint.properties.campaign["click_id"]).toBe("gclid_value");
  });
});

describe("attribution-engine runtime — replay determinism", () => {
  it("re-running the same input slice over a fresh store produces identical touchpoint_captured events", async () => {
    // First "live" run.
    const run1 = buildRuntime();
    await run1.runtime.handler(
      buildPayload(
        encodeEnvelope({
          event_id: "evt_replay",
          anonymous_id: "anon_X",
          campaign: FULL_CAMPAIGN,
        }),
      ),
      buildContext(),
    );

    // Second "replay" run over the SAME slice with a fresh store.
    const run2 = buildRuntime();
    await run2.runtime.handler(
      buildPayload(
        encodeEnvelope({
          event_id: "evt_replay",
          anonymous_id: "anon_X",
          campaign: FULL_CAMPAIGN,
        }),
      ),
      buildContext(),
    );

    // Both runs emit a touchpoint_captured with the same touchpoint_id.
    const live = run1.producer.publishes[0]?.payload as {
      properties: { touchpoint_id: string };
    };
    const replay = run2.producer.publishes[0]?.payload as {
      properties: { touchpoint_id: string };
    };
    expect(live.properties.touchpoint_id).toBe(replay.properties.touchpoint_id);
  });
});

describe("attribution-engine runtime — partition key + canonical envelope", () => {
  it("publishes the canonical envelope shape decodable through decodeEvent", async () => {
    const { runtime, producer } = buildRuntime();
    await runtime.handler(
      buildPayload(
        encodeEnvelope({
          event_id: "evt_envelope",
          anonymous_id: "anon_X",
          campaign: FULL_CAMPAIGN,
        }),
      ),
      buildContext(),
    );

    // RecordingProducer keeps the parsed object; verify decodeEvent
    // also round-trips a JSON-serialised version (the wire format).
    const envelope = producer.publishes[0]?.payload as Record<string, unknown>;
    const wire = Buffer.from(JSON.stringify(envelope), "utf8");
    const decoded = decodeEvent(wire) as Record<string, unknown>;
    expect(decoded["event"]).toBe("attribution.touchpoint_captured");
    expect(decoded["schema_version"]).toBe(1);
    expect(decoded["processor_name"]).toBe(PROCESSOR_NAME);
  });
});

describe("createRuntime activation gate (attribution-engine v2)", () => {
  it("records no touchpoint for a scope an operator disabled", async () => {
    const { runtime, producer, store } = buildRuntime({
      gate: gateDisabling({ project_id: "checkout", environment: "production" }),
    });

    await runtime.handler(
      buildPayload(encodeEnvelope({ anonymous_id: "anon_X", campaign: FULL_CAMPAIGN })),
      buildContext(),
    );

    expect(producer.publishes.length).toBe(0);
    // Nothing reached the store either — the skip lands before any work.
    expect(store.size()).toBe(0);
    expect(skippedTotal(runtime.metrics)).toBe(1);
  });

  it("keeps attributing scopes the disable does not name", async () => {
    const { runtime, producer } = buildRuntime({
      gate: gateDisabling({ project_id: "checkout", environment: "development" }),
    });

    // A campaign is what makes this event a touchpoint at all; without one
    // the processor legitimately emits nothing and the test would pass for
    // the wrong reason.
    await runtime.handler(
      buildPayload(encodeEnvelope({ anonymous_id: "anon_X", campaign: FULL_CAMPAIGN })),
      buildContext(),
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
