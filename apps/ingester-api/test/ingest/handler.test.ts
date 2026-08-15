import { createLogger } from "@polaris/shared-logger";
import {
  POLARIS_INGEST_REDACTED_PATTERN_TOTAL,
  POLICY_REASON_PII_CARD,
  POLICY_REASON_PII_SECRET,
} from "@polaris/shared-policy";
import {
  BATCH_REASON_DUPLICATE,
  BATCH_REASON_FORBIDDEN_FIELD_REJECTED,
  BATCH_REASON_IN_PROGRESS,
  BATCH_REASON_PUBLISH_FAILED,
  envelopeSchema,
  SCHEMA_REASON_INVALID_PROPERTIES,
  SCHEMA_REASON_SUNSET,
  SCHEMA_REASON_UNSUPPORTED_VERSION,
} from "@polaris/shared-schemas";
import { beforeEach, describe, expect, it } from "vitest";

import type { AuthenticatedRequestContext } from "../../src/auth/index.js";
import type { IngesterConfig } from "../../src/config.js";
import { DisabledDedupeStore, InMemoryDedupeStore } from "../../src/dedupe/index.js";
import { createIngestHandler } from "../../src/ingest/handler.js";
import type { QuarantineCandidate, QuarantinePublisher } from "../../src/ingest/quarantine.js";
import {
  IngestMetrics,
  METRIC_INGEST_BATCH_ACCEPTED_TOTAL,
  METRIC_INGEST_BATCH_REJECTED_TOTAL,
  METRIC_INGEST_DEDUPE_HIT_TOTAL,
  METRIC_INGEST_DEDUPE_SKIPPED_TOTAL,
  METRIC_INGEST_DEPRECATED_SCHEMA_VERSION_TOTAL,
  METRIC_INGEST_PUBLISH_FAILED_TOTAL,
  METRIC_INGEST_PUBLISH_SUCCESS_TOTAL,
} from "../../src/metrics/registry.js";
import { createPolicyResolver } from "../../src/policy/loader.js";
import type { IngestProjectConfigLookup } from "../../src/project-config-lookup.js";

import {
  buildEnvelopePayload,
  buildTestCatalog,
  RecordingDedupeStore,
  RecordingProducer,
  testConfig,
} from "../fixtures.js";

const SILENT_LOGGER = createLogger({
  service: "ingester-api-test",
  version: "0.0.0",
  env: "test",
});

const AUTH: AuthenticatedRequestContext = {
  apiKeyId: "ak_test",
  projectId: "checkout",
  environment: "production",
  source: { id: "storefront-web", type: "browser" },
};

function deps(
  overrides: {
    producer?: RecordingProducer;
    dedupe?: InMemoryDedupeStore | RecordingDedupeStore;
    metrics?: IngestMetrics;
    config?: IngesterConfig["ingest"];
    projectDedupeWindows?: Record<string, number>;
    projectConfig?: IngestProjectConfigLookup;
    now?: () => Date;
    quarantine?: QuarantinePublisher;
  } = {},
) {
  const catalog = buildTestCatalog();
  const policy = createPolicyResolver();
  const producer = overrides.producer ?? new RecordingProducer();
  const dedupe = overrides.dedupe ?? new InMemoryDedupeStore();
  const ingestConfig = overrides.config ?? testConfig.ingest;
  // Stands in for the project-config lookup. The real one reads a cache
  // synchronously and falls back to these same deployment defaults, so a
  // plain map is a faithful double for handler-level tests.
  const projectConfig = overrides.projectConfig ?? {
    dedupeWindowSec: (projectId: string) =>
      Math.min(
        overrides.projectDedupeWindows?.[projectId] ?? ingestConfig.defaultDedupeWindowSec,
        ingestConfig.maxDedupeWindowSec,
      ),
    rateLimitRps: () => 1000,
  };
  const metrics = overrides.metrics ?? new IngestMetrics();
  return {
    handler: createIngestHandler({
      catalog,
      policy,
      // Recording producer satisfies the structural PolarisProducer shape.
      producer: producer as unknown as Parameters<typeof createIngestHandler>[0]["producer"],
      dedupe,
      metrics,
      logger: SILENT_LOGGER,
      ingestConfig,
      projectConfig,
      ...(overrides.now !== undefined ? { now: overrides.now } : {}),
      ...(overrides.quarantine !== undefined ? { quarantine: overrides.quarantine } : {}),
    }),
    producer,
    dedupe,
    metrics,
  };
}

function context(): Parameters<ReturnType<typeof createIngestHandler>["handle"]>[1] {
  return {
    auth: AUTH,
    receivedAt: new Date("2026-05-12T10:00:00.000Z"),
    requestId: "test-request-id",
  };
}

describe("ingest handler — valid batch", () => {
  it("accepts a valid page.viewed v2 event and publishes to raw.events", async () => {
    const { handler, producer, metrics } = deps();
    const payload = {
      events: [buildEnvelopePayload()],
    };
    const result = await handler.handle(payload, context());
    expect(result.status).toBe(200);
    if (!("accepted" in result.body)) throw new Error("expected batch body");
    expect(result.body.accepted).toHaveLength(1);
    expect(result.body.rejected).toHaveLength(0);
    expect(result.body.accepted[0]?.status).toBe("accepted");
    // Producer was called once with the family + envelope.
    expect(producer.publishes).toHaveLength(1);
    const publish = producer.publishes[0];
    expect(publish?.family).toBe("raw.events");
    expect(publish?.event["project_id"]).toBe("checkout");
    expect(publish?.event["environment"]).toBe("production");
    expect(publish?.event["ingested_at"]).toBe("2026-05-12T10:00:00.000Z");
    // Trusted source id was stamped from the API key.
    const source = publish?.event["source"] as Record<string, unknown>;
    expect(source["id"]).toBe("storefront-web");
    // Producer's other source attributes (sdk, sdk_version) survive.
    expect(source["sdk"]).toBe("web");
    expect(source["sdk_version"]).toBe("1.0.0");
    // Partition key follows project:env:identity (anonymous_id wins here).
    expect(publish?.partitionKey).toBe("checkout:production:anon-1");
    // The published envelope passes the canonical envelope schema.
    expect(envelopeSchema.safeParse(publish?.event).success).toBe(true);
    // Accepted metric incremented.
    expect(
      metrics.getCounter(METRIC_INGEST_BATCH_ACCEPTED_TOTAL, {
        project_id: "checkout",
        environment: "production",
      }),
    ).toBe(1);
  });

  it("stamps project_id, environment, ingested_at, and source.id even when producer sent garbage", async () => {
    const { handler, producer } = deps();
    const payload = {
      events: [
        buildEnvelopePayload({
          project_id: "evil-project",
          environment: "evil-env",
          ingested_at: "2020-01-01T00:00:00.000Z",
          source: { type: "backend", id: "evil-source", sdk: "evil", sdk_version: "0.0.0" },
        }),
      ],
    };
    const ctx = context();
    const result = await handler.handle(payload, ctx);
    expect(result.status).toBe(200);
    expect(producer.publishes).toHaveLength(1);
    const e = producer.publishes[0]?.event;
    expect(e?.["project_id"]).toBe(AUTH.projectId);
    expect(e?.["environment"]).toBe(AUTH.environment);
    expect(e?.["ingested_at"]).toBe(ctx.receivedAt.toISOString());
    expect((e?.["source"] as Record<string, unknown>)["id"]).toBe(AUTH.source.id);
  });

  it("partial-batch: one invalid event does not block the rest of the batch", async () => {
    const { handler, producer } = deps();
    const valid = buildEnvelopePayload();
    // event_id stays unique for the second envelope so the dedupe layer does
    // not coalesce them.
    const invalid = buildEnvelopePayload({
      event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f552",
      properties: { /* missing required `path`, `search`, `title`, `referrer` */ search: null },
    });
    const result = await handler.handle({ events: [valid, invalid] }, context());
    expect(result.status).toBe(200);
    if (!("accepted" in result.body)) throw new Error("expected batch body");
    expect(result.body.accepted).toHaveLength(1);
    expect(result.body.rejected).toHaveLength(1);
    expect(result.body.rejected[0]?.code).toBe(SCHEMA_REASON_INVALID_PROPERTIES);
    expect(producer.publishes).toHaveLength(1);
  });
});

describe("ingest handler — forbidden-field policy", () => {
  it("rejects an event with a named forbidden field (`password`) before logging or publishing", async () => {
    const { handler, producer, metrics } = deps();
    const payload = {
      events: [
        buildEnvelopePayload({
          properties: { path: "/", search: null, title: "x", referrer: null, password: "p4ss" },
        }),
      ],
    };
    const result = await handler.handle(payload, context());
    expect(result.status).toBe(200);
    if (!("accepted" in result.body)) throw new Error("expected batch body");
    expect(result.body.accepted).toHaveLength(0);
    expect(result.body.rejected).toHaveLength(1);
    expect(result.body.rejected[0]?.code).toBe(BATCH_REASON_FORBIDDEN_FIELD_REJECTED);
    expect(result.body.rejected[0]?.detail?.policy_reason).toBe(POLICY_REASON_PII_SECRET);
    // Rejected events never publish.
    expect(producer.publishes).toHaveLength(0);
    expect(
      metrics.getCounter(METRIC_INGEST_BATCH_REJECTED_TOTAL, {
        project_id: "checkout",
        environment: "production",
        reason: "forbidden_field_rejected",
      }),
    ).toBe(1);
  });

  it("redacts a Luhn-valid PAN in a non-card field and emits the redaction metric", async () => {
    const { handler, producer, metrics } = deps();
    // 4111111111111111 is a Luhn-valid VISA test PAN.
    const payload = {
      events: [
        buildEnvelopePayload({
          properties: {
            path: "/",
            search: null,
            title: "leak",
            referrer: "https://example.com/?card=4111111111111111",
          },
        }),
      ],
    };
    const result = await handler.handle(payload, context());
    expect(result.status).toBe(200);
    if (!("accepted" in result.body)) throw new Error("expected batch body");
    expect(result.body.accepted).toHaveLength(1);
    // The event was published with the value redacted.
    expect(producer.publishes).toHaveLength(1);
    const properties = producer.publishes[0]?.event["properties"] as Record<string, unknown>;
    expect(properties["referrer"]).toBe("[REDACTED:pii_card]");
    // Metric carries reason + pattern labels but never the value.
    expect(
      metrics.getCounter(POLARIS_INGEST_REDACTED_PATTERN_TOTAL, {
        project_id: "checkout",
        environment: "production",
        reason: POLICY_REASON_PII_CARD,
        pattern: "luhn_pan",
      }),
    ).toBe(1);
  });

  it("redaction metric labels never contain the raw value", async () => {
    const { handler, metrics } = deps();
    const payload = {
      events: [
        buildEnvelopePayload({
          properties: {
            path: "/",
            search: null,
            title: "x",
            referrer: "AKIAIOSFODNN7EXAMPLE", // AWS access key pattern
          },
        }),
      ],
    };
    await handler.handle(payload, context());
    const samples = metrics
      .getSamples()
      .filter((s) => s.name === POLARIS_INGEST_REDACTED_PATTERN_TOTAL);
    expect(samples).toHaveLength(1);
    const labelValues = Object.values(samples[0]?.labels ?? {});
    for (const value of labelValues) {
      expect(String(value)).not.toContain("AKIA");
      expect(String(value)).not.toContain("AKIAIOSFODNN7EXAMPLE");
    }
  });
});

describe("ingest handler — schema evolution", () => {
  it("rejects an unknown schema_version with `unsupported_schema_version`", async () => {
    const { handler } = deps();
    const payload = {
      events: [buildEnvelopePayload({ schema_version: 99 })],
    };
    const result = await handler.handle(payload, context());
    if (!("accepted" in result.body)) throw new Error("expected batch body");
    expect(result.body.rejected[0]?.code).toBe(SCHEMA_REASON_UNSUPPORTED_VERSION);
    expect(result.body.rejected[0]?.detail?.supported_versions).toContain(2);
  });

  it("rejects events past `sunset_at` with `schema_version_sunset`", async () => {
    // page.viewed v1 has sunset_at "2026-08-10T00:00:00Z" in our test catalog.
    const { handler } = deps({
      now: () => new Date("2026-09-01T00:00:00.000Z"),
    });
    const payload = {
      events: [
        buildEnvelopePayload({
          schema_version: 1,
          properties: { path: "/?q=1", title: "old", host: "old.example.com" },
        }),
      ],
    };
    const result = await handler.handle(payload, context());
    if (!("accepted" in result.body)) throw new Error("expected batch body");
    expect(result.body.rejected[0]?.code).toBe(SCHEMA_REASON_SUNSET);
    expect(result.body.rejected[0]?.detail?.sunset_at).toBe("2026-08-10T00:00:00Z");
  });

  it("accepts a deprecated-but-pre-sunset event and emits the deprecated metric", async () => {
    const { handler, metrics, producer } = deps({
      now: () => new Date("2026-05-12T00:00:00.000Z"),
    });
    const payload = {
      events: [
        buildEnvelopePayload({
          schema_version: 1,
          properties: { path: "/?q=1", title: "old", host: "old.example.com" },
        }),
      ],
    };
    const result = await handler.handle(payload, context());
    if (!("accepted" in result.body)) throw new Error("expected batch body");
    expect(result.body.accepted).toHaveLength(1);
    expect(result.body.accepted[0]?.deprecated).toBe(true);
    expect(producer.publishes).toHaveLength(1);
    expect(
      metrics.getCounter(METRIC_INGEST_DEPRECATED_SCHEMA_VERSION_TOTAL, {
        event: "page.viewed",
        schema_version: 1,
      }),
    ).toBe(1);
  });
});

describe("ingest handler — dedupe", () => {
  let dedupe: InMemoryDedupeStore;
  beforeEach(() => {
    dedupe = new InMemoryDedupeStore();
  });

  it("rejects a duplicate event_id within the dedupe window with `duplicate`", async () => {
    const { handler, producer, metrics } = deps({ dedupe });
    const first = await handler.handle({ events: [buildEnvelopePayload()] }, context());
    const second = await handler.handle({ events: [buildEnvelopePayload()] }, context());
    if (!("accepted" in first.body) || !("accepted" in second.body)) throw new Error("oops");
    expect(first.body.accepted).toHaveLength(1);
    expect(second.body.accepted).toHaveLength(0);
    expect(second.body.rejected[0]?.code).toBe(BATCH_REASON_DUPLICATE);
    expect(producer.publishes).toHaveLength(1);
    expect(
      metrics.getCounter(METRIC_INGEST_DEDUPE_HIT_TOTAL, {
        project_id: "checkout",
        environment: "production",
      }),
    ).toBe(1);
  });

  it("respects per-project dedupe overrides (longer window)", async () => {
    // Previously this asserted only that ONE claim landed, which the default
    // window satisfies just as well — the override could have been ignored
    // entirely and the test would still pass. It now records the TTL the
    // handler actually asked for.
    const seen: number[] = [];
    const recording = new InMemoryDedupeStore();
    // The dedupe entry is a LEASE: claim() writes a short-lived hold before
    // the publish, and confirm() extends it to the real window once the event
    // is safely on the broker. The per-project window therefore lands on
    // confirm, not claim.
    const confirm = recording.confirm.bind(recording);
    recording.confirm = async (input) => {
      seen.push(input.ttlSec);
      return confirm(input);
    };
    const { handler } = deps({
      dedupe: recording,
      projectDedupeWindows: { [AUTH.projectId]: 86_400 },
    });
    await handler.handle({ events: [buildEnvelopePayload()] }, context());
    expect(seen).toEqual([86_400]);
  });

  it("caps a per-project dedupe window at the platform maximum", async () => {
    // The cap is a deployment guardrail: a project must not be able to raise
    // its own ceiling by storing a larger value.
    const seen: number[] = [];
    const recording = new InMemoryDedupeStore();
    // The dedupe entry is a LEASE: claim() writes a short-lived hold before
    // the publish, and confirm() extends it to the real window once the event
    // is safely on the broker. The per-project window therefore lands on
    // confirm, not claim.
    const confirm = recording.confirm.bind(recording);
    recording.confirm = async (input) => {
      seen.push(input.ttlSec);
      return confirm(input);
    };
    const { handler } = deps({
      dedupe: recording,
      projectDedupeWindows: { [AUTH.projectId]: 999_999_999 },
    });
    await handler.handle({ events: [buildEnvelopePayload()] }, context());
    expect(seen).toEqual([testConfig.ingest.maxDedupeWindowSec]);
  });

  it("continues without dedupe and increments the skipped metric when Redis is down", async () => {
    const recording = new RecordingDedupeStore();
    recording.alwaysSkip = true;
    const { handler, producer, metrics } = deps({ dedupe: recording });
    const result = await handler.handle({ events: [buildEnvelopePayload()] }, context());
    if (!("accepted" in result.body)) throw new Error("expected batch body");
    expect(result.body.accepted).toHaveLength(1);
    expect(producer.publishes).toHaveLength(1);
    expect(
      metrics.getCounter(METRIC_INGEST_DEDUPE_SKIPPED_TOTAL, {
        project_id: "checkout",
        environment: "production",
      }),
    ).toBe(1);
  });

  it("idempotency-at-edge: longer window opt-in dedupes events that arrive 30 minutes apart", async () => {
    // Default 15-min window would NOT dedupe a 30-minute-late retry; the
    // 24-hour opt-in does. The InMemoryDedupeStore uses absolute expiry so
    // we simulate the time-travel by hand.
    let nowMs = Date.parse("2026-05-12T10:00:00.000Z");
    const dedupe = new InMemoryDedupeStore({ now: () => nowMs });
    const { handler, producer } = deps({
      dedupe,
      projectDedupeWindows: { [AUTH.projectId]: 86_400 },
    });
    await handler.handle({ events: [buildEnvelopePayload()] }, context());
    expect(producer.publishes).toHaveLength(1);
    // Jump 30 minutes forward; the 24-hour window should still hold the claim.
    nowMs += 30 * 60_000;
    const retry = await handler.handle({ events: [buildEnvelopePayload()] }, context());
    if (!("accepted" in retry.body)) throw new Error("expected batch body");
    expect(retry.body.rejected[0]?.code).toBe(BATCH_REASON_DUPLICATE);
    expect(producer.publishes).toHaveLength(1);
  });
});

describe("ingest handler — dedupe lease", () => {
  it("lets the client's retry succeed after a publish failure", async () => {
    // The regression this whole layer was rebuilt for. The claim is written
    // BEFORE the publish so a retry storm's second copy never reaches the
    // broker — which means a failed publish used to leave a claim standing
    // over an event that does not exist. The response says "retry the
    // event"; the retry then hit that claim, came back `duplicate`, and the
    // event was gone. Permanently, and on nothing worse than a broker blip.
    const producer = new RecordingProducer();
    producer.throwOnPublish = new Error("broker unavailable");
    const dedupe = new InMemoryDedupeStore();
    const { handler } = deps({ producer, dedupe });

    const first = await handler.handle({ events: [buildEnvelopePayload()] }, context());
    if (!("accepted" in first.body)) throw new Error("expected batch body");
    expect(first.body.rejected[0]?.code).toBe(BATCH_REASON_PUBLISH_FAILED);
    // The lease was dropped, so nothing is held over an event that does not exist.
    expect(dedupe.size()).toBe(0);

    // `throwOnPublish` is one-shot, so this retry is the client obeying the
    // instruction it was handed.
    const retry = await handler.handle({ events: [buildEnvelopePayload()] }, context());
    if (!("accepted" in retry.body)) throw new Error("expected batch body");
    expect(retry.body.rejected).toHaveLength(0);
    expect(retry.body.accepted[0]?.status).toBe("accepted");
    expect(producer.publishes).toHaveLength(1);
  });

  it("still rejects a genuine duplicate after a successful publish", async () => {
    // The lease must not weaken the thing the layer exists for.
    const dedupe = new InMemoryDedupeStore();
    const { handler, producer } = deps({ dedupe });

    await handler.handle({ events: [buildEnvelopePayload()] }, context());
    const again = await handler.handle({ events: [buildEnvelopePayload()] }, context());
    if (!("accepted" in again.body)) throw new Error("expected batch body");
    expect(again.body.rejected[0]?.code).toBe(BATCH_REASON_DUPLICATE);
    expect(producer.publishes).toHaveLength(1);
  });

  it("promotes the lease to the full per-project window on success", async () => {
    // Confirm has to actually extend the entry, or every dedupe window
    // silently collapses to the 60s lease.
    let nowMs = Date.parse("2026-05-12T10:00:00.000Z");
    const dedupe = new InMemoryDedupeStore({ now: () => nowMs });
    const { handler, producer } = deps({ dedupe });

    await handler.handle({ events: [buildEnvelopePayload()] }, context());
    // Past the 60s lease, inside the 15-minute default window.
    nowMs += 5 * 60_000;
    const late = await handler.handle({ events: [buildEnvelopePayload()] }, context());
    if (!("accepted" in late.body)) throw new Error("expected batch body");
    expect(late.body.rejected[0]?.code).toBe(BATCH_REASON_DUPLICATE);
    expect(producer.publishes).toHaveLength(1);
  });

  it("tells a competing request `in_progress`, not `duplicate`, while a lease is open", async () => {
    // The distinction the state field exists for. During the lease the
    // platform does NOT have the event, so a producer told `duplicate` would
    // rightly stop retrying and lose it. `in_progress` is retryable.
    const dedupe = new InMemoryDedupeStore();
    await dedupe.claim({
      projectId: "checkout",
      environment: "production",
      eventId: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
      ttlSec: 60,
    });
    const { handler, producer } = deps({ dedupe });

    const result = await handler.handle({ events: [buildEnvelopePayload()] }, context());
    if (!("accepted" in result.body)) throw new Error("expected batch body");
    expect(result.body.rejected[0]?.code).toBe(BATCH_REASON_IN_PROGRESS);
    expect(producer.publishes).toHaveLength(0);
  });

  it("tells a competing request `duplicate` once the event is confirmed", async () => {
    const dedupe = new InMemoryDedupeStore();
    const { handler } = deps({ dedupe });
    await handler.handle({ events: [buildEnvelopePayload()] }, context());

    const again = await handler.handle({ events: [buildEnvelopePayload()] }, context());
    if (!("accepted" in again.body)) throw new Error("expected batch body");
    // Confirmed: the platform really does have it, so this producer may stop.
    expect(again.body.rejected[0]?.code).toBe(BATCH_REASON_DUPLICATE);
  });

  it("does not hold a lease when the store skipped the claim", async () => {
    // Redis down: nothing was claimed, so there is nothing to release, and
    // the publish-failure path must not invent a release call.
    const producer = new RecordingProducer();
    producer.throwOnPublish = new Error("broker unavailable");
    const dedupe = new DisabledDedupeStore();
    const { handler } = deps({ producer, dedupe: dedupe as never });

    const result = await handler.handle({ events: [buildEnvelopePayload()] }, context());
    if (!("accepted" in result.body)) throw new Error("expected batch body");
    expect(result.body.rejected[0]?.code).toBe(BATCH_REASON_PUBLISH_FAILED);
  });
});

describe("ingest handler — publish failures", () => {
  it("returns `publish_failed` when the producer throws and does not crash the batch", async () => {
    const producer = new RecordingProducer();
    producer.throwOnPublish = new Error("broker unavailable");
    const valid = buildEnvelopePayload();
    const second = buildEnvelopePayload({ event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f560" });
    const { handler, metrics } = deps({ producer });
    const result = await handler.handle({ events: [valid, second] }, context());
    if (!("accepted" in result.body)) throw new Error("expected batch body");
    // First event throws; second succeeds (the producer's `throwOnPublish`
    // is one-shot).
    expect(result.body.accepted).toHaveLength(1);
    expect(result.body.rejected).toHaveLength(1);
    expect(result.body.rejected[0]?.code).toBe(BATCH_REASON_PUBLISH_FAILED);
    expect(
      metrics.getCounter(METRIC_INGEST_BATCH_REJECTED_TOTAL, {
        project_id: "checkout",
        environment: "production",
        reason: BATCH_REASON_PUBLISH_FAILED,
      }),
    ).toBe(1);
    expect(
      metrics.getCounter(METRIC_INGEST_PUBLISH_FAILED_TOTAL, {
        project_id: "checkout",
        environment: "production",
        topic: "raw.events",
        reason: "Error",
      }),
    ).toBe(1);
    expect(
      metrics.getCounter(METRIC_INGEST_PUBLISH_SUCCESS_TOTAL, {
        project_id: "checkout",
        environment: "production",
        topic: "raw.events",
      }),
    ).toBe(1);
  });

  it("increments publish_failed exactly once per failure (no double counting per call)", async () => {
    const producer = new RecordingProducer();
    const first = buildEnvelopePayload();
    const second = buildEnvelopePayload({ event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f561" });
    const { handler, metrics } = deps({ producer });

    producer.throwOnPublish = new Error("broker unavailable");
    await handler.handle({ events: [first] }, context());
    producer.throwOnPublish = new Error("broker unavailable");
    await handler.handle({ events: [second] }, context());

    // Two failures, two increments — never more, never less.
    expect(
      metrics.getCounter(METRIC_INGEST_PUBLISH_FAILED_TOTAL, {
        project_id: "checkout",
        environment: "production",
        topic: "raw.events",
        reason: "Error",
      }),
    ).toBe(2);
    expect(
      metrics.getCounter(METRIC_INGEST_PUBLISH_SUCCESS_TOTAL, {
        project_id: "checkout",
        environment: "production",
        topic: "raw.events",
      }),
    ).toBe(0);
  });
});

describe("ingest handler — invalid request", () => {
  it("returns 400 invalid_request when the batch envelope is malformed", async () => {
    const { handler } = deps();
    const result = await handler.handle({ not_events: [] }, context());
    expect(result.status).toBe(400);
    expect("error" in result.body && result.body.error.code).toBe("invalid_request");
  });

  it("returns 413 when the batch exceeds the configured maximum", async () => {
    const { handler } = deps({
      config: { ...testConfig.ingest, maxBatchEvents: 2 },
    });
    const events = [
      buildEnvelopePayload({ event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f553" }),
      buildEnvelopePayload({ event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f554" }),
      buildEnvelopePayload({ event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f555" }),
    ];
    const result = await handler.handle({ events }, context());
    expect(result.status).toBe(413);
  });

  it("returns an empty 200 response for an empty batch", async () => {
    const { handler, producer } = deps();
    const result = await handler.handle({ events: [] }, context());
    expect(result.status).toBe(200);
    if (!("accepted" in result.body)) throw new Error("expected batch body");
    expect(result.body.accepted).toEqual([]);
    expect(result.body.rejected).toEqual([]);
    expect(producer.publishes).toHaveLength(0);
  });
});

describe("ingest handler — partition key", () => {
  it("partitions on customer_id > anonymous_id > session_id > event_id", async () => {
    const { handler, producer } = deps();
    const cases = [
      {
        event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f570",
        identity: {
          customer_id: "cus_1",
          anonymous_id: "anon_1",
          session_id: "sess_1",
          device_id: null,
        },
        expected: "checkout:production:cus_1",
      },
      {
        event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f571",
        identity: {
          customer_id: null,
          anonymous_id: "anon_2",
          session_id: "sess_2",
          device_id: null,
        },
        expected: "checkout:production:anon_2",
      },
      {
        event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f572",
        identity: { customer_id: null, anonymous_id: null, session_id: "sess_3", device_id: null },
        expected: "checkout:production:sess_3",
      },
      {
        event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f573",
        identity: { customer_id: null, anonymous_id: null, session_id: null, device_id: null },
        expected: "checkout:production:018f1b9e-7b50-7b12-9a2e-0e2f88d8f573",
      },
    ];

    for (const tc of cases) {
      await handler.handle(
        { events: [buildEnvelopePayload({ event_id: tc.event_id, identity: tc.identity })] },
        context(),
      );
      const lastIndex = producer.publishes.length - 1;
      expect(producer.publishes[lastIndex]?.partitionKey).toBe(tc.expected);
    }
  });
});

describe("ingest handler — retryable flag", () => {
  it("marks publish_failed retryable so a producer resends instead of dropping", async () => {
    // The flag the SDKs branch on. It was absent from the schema entirely, so
    // `retryable === true` was never true and every SDK treated a transient
    // broker failure as a permanent one.
    const producer = new RecordingProducer();
    producer.throwOnPublish = new Error("broker unavailable");
    const { handler } = deps({ producer });
    const result = await handler.handle({ events: [buildEnvelopePayload()] }, context());
    if (!("accepted" in result.body)) throw new Error("expected batch body");
    expect(result.body.rejected[0]?.code).toBe(BATCH_REASON_PUBLISH_FAILED);
    expect(result.body.rejected[0]?.retryable).toBe(true);
  });

  it("marks in_progress retryable", async () => {
    const dedupe = new InMemoryDedupeStore();
    await dedupe.claim({
      projectId: "checkout",
      environment: "production",
      eventId: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
      ttlSec: 60,
    });
    const { handler } = deps({ dedupe });
    const result = await handler.handle({ events: [buildEnvelopePayload()] }, context());
    if (!("accepted" in result.body)) throw new Error("expected batch body");
    expect(result.body.rejected[0]?.retryable).toBe(true);
  });

  it("marks duplicate and validation failures permanent", async () => {
    const dedupe = new InMemoryDedupeStore();
    const { handler } = deps({ dedupe });
    await handler.handle({ events: [buildEnvelopePayload()] }, context());
    const again = await handler.handle({ events: [buildEnvelopePayload()] }, context());
    if (!("accepted" in again.body)) throw new Error("expected batch body");
    // Already stored: retrying it forever would be waste, not safety.
    expect(again.body.rejected[0]?.code).toBe(BATCH_REASON_DUPLICATE);
    expect(again.body.rejected[0]?.retryable).toBe(false);

    const bad = await handler.handle(
      { events: [buildEnvelopePayload({ properties: {} })] },
      context(),
    );
    if (!("accepted" in bad.body)) throw new Error("expected batch body");
    expect(bad.body.rejected[0]?.retryable).toBe(false);
  });
});

describe("the quarantine hook", () => {
  /** A publisher that records what it was handed and when it settled. */
  function recordingQuarantine() {
    const seen: QuarantineCandidate[][] = [];
    let release: (() => void) | undefined;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const quarantine: QuarantinePublisher = {
      publish: async (candidates) => {
        seen.push([...candidates]);
        release?.();
      },
    };
    return { quarantine, seen, settled };
  }

  it("hands every rejection to the quarantine, with the payload that caused it", async () => {
    // The wiring test. A publisher that is never called is a publisher
    // that does not exist, and nothing else in this file would notice.
    const { quarantine, seen, settled } = recordingQuarantine();
    const { handler } = deps({ quarantine });

    const response = await handler.handle(
      { events: [{ ...buildEnvelopePayload(), properties: { cvv: "123" } }] },
      context(),
    );
    await settled;

    expect(response.body.rejected).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(1);
    expect(seen[0]?.[0]?.rejected.code).toBe("forbidden_field_rejected");
    expect(seen[0]?.[0]?.projectId).toBe(AUTH.projectId);
    // The RAW payload, so the sample builder can redact it — the handler
    // must not hand over something already stripped of the evidence.
    expect((seen[0]?.[0]?.raw as { properties: { cvv: string } }).properties.cvv).toBe("123");
  });

  it("does not call the quarantine when nothing was rejected", async () => {
    const { quarantine, seen } = recordingQuarantine();
    const { handler } = deps({ quarantine });

    await handler.handle({ events: [buildEnvelopePayload()] }, context());
    await Promise.resolve();

    expect(seen).toEqual([]);
  });

  it("answers the producer without waiting for the publish", async () => {
    // Fire-and-forget. The response is already computed; awaiting a broker
    // round trip here would put the quarantine's availability on the
    // ingestion latency path.
    let resolvePublish: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      resolvePublish = resolve;
    });
    const { handler } = deps({
      quarantine: { publish: () => blocked },
    });

    const response = await handler.handle(
      { events: [{ ...buildEnvelopePayload(), properties: { cvv: "123" } }] },
      context(),
    );

    // Returned while the publish is still hanging.
    expect(response.status).toBe(200);
    expect(response.body.rejected).toHaveLength(1);
    resolvePublish?.();
  });

  it("answers normally when the quarantine throws", async () => {
    // Fail-open through the handler as well as inside the publisher: a
    // bug in the publisher must not become an unhandled rejection.
    const { handler } = deps({
      quarantine: {
        publish: async () => {
          throw new Error("quarantine exploded");
        },
      },
    });

    const response = await handler.handle(
      { events: [{ ...buildEnvelopePayload(), properties: { cvv: "123" } }] },
      context(),
    );

    expect(response.status).toBe(200);
    expect(response.body.rejected).toHaveLength(1);
  });

  it("rejects exactly as before when no quarantine is configured", async () => {
    const { handler } = deps();
    const response = await handler.handle(
      { events: [{ ...buildEnvelopePayload(), properties: { cvv: "123" } }] },
      context(),
    );
    expect(response.body.rejected).toHaveLength(1);
  });
});
