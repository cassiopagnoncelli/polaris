/**
 * The ingest counters carry an `event` label, and it cannot be forged.
 *
 * Two separate promises, and a check for each.
 *
 * **The label exists.** R12 specifies per-event-type volume-anomaly alerts.
 * `PolarisIngestRejectionSpike` was written for them and its own comment
 * says it "reads per-event-type volume" — while grouping by
 * `(project_id, environment, reason)`, because the counter carried no
 * event dimension at all. An alert cannot group by a label the emitter
 * does not emit; it silently groups by what is there and reports a
 * project-wide spike, which is the same answer for a bad SDK release and
 * for one broken event type. Lint checks metric NAMES and says so; labels
 * are a test's job.
 *
 * **The label is bounded.** An event name on a REJECTED event is whatever
 * the producer sent — it is rejected precisely because nothing has
 * validated it. Labelling a counter with it directly turns an API key into
 * a licence to mint Prometheus series, one per unique string, which is a
 * denial-of-service against the monitoring system rather than against the
 * ingester. So anything the catalog does not register collapses to
 * `<unregistered>`, and the specific name is recoverable from the
 * quarantine record instead.
 *
 * The second property is the one worth guarding: a change that "improves"
 * the label by passing the raw name through would look like a fix.
 */

import { createLogger } from "@polaris/observability-logger";
import { describe, expect, it } from "vitest";

import { createIngestHandler } from "../../src/ingest/handler.js";
import type { IngestRequestContext } from "../../src/ingest/types.js";
import type { AuthenticatedRequestContext } from "../../src/auth/types.js";
import { InMemoryDedupeStore } from "../../src/dedupe/index.js";
import {
  eventLabel,
  IngestMetrics,
  METRIC_INGEST_BATCH_ACCEPTED_TOTAL,
  METRIC_INGEST_BATCH_REJECTED_TOTAL,
  UNREGISTERED_EVENT_LABEL,
} from "../../src/metrics/registry.js";
import { createPolicyResolver } from "../../src/policy/loader.js";
import {
  buildEnvelopePayload,
  buildTestCatalog,
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

function build() {
  const metrics = new IngestMetrics();
  const producer = new RecordingProducer();
  const handler = createIngestHandler({
    catalog: buildTestCatalog(),
    policy: createPolicyResolver(),
    producer: producer as unknown as Parameters<typeof createIngestHandler>[0]["producer"],
    dedupe: new InMemoryDedupeStore(),
    metrics,
    logger: SILENT_LOGGER,
    ingestConfig: testConfig.ingest,
    projectConfig: {
      dedupeWindowSec: () => testConfig.ingest.defaultDedupeWindowSec,
      rateLimitRps: () => 1000,
    },
  });
  const context: IngestRequestContext = {
    auth: AUTH,
    receivedAt: new Date("2026-08-19T10:00:00.000Z"),
    requestId: "req_test",
  };
  return { handler, metrics, producer, context };
}

/** Every `event` label value the registry has observed for one metric. */
function labelsFor(metrics: IngestMetrics, metric: string): string[] {
  return metrics
    .getSamples()
    .filter((sample) => sample.name === metric)
    .map((sample) => String(sample.labels["event"]))
    .sort();
}

describe("eventLabel", () => {
  const catalog = { hasEvent: (name: string) => name === "page.viewed" };

  it("passes through a name the catalog registers", () => {
    expect(eventLabel("page.viewed", catalog)).toBe("page.viewed");
  });

  it("collapses a name the catalog does not register", () => {
    expect(eventLabel("totally.made.up", catalog)).toBe(UNREGISTERED_EVENT_LABEL);
  });

  it("collapses absent and empty names rather than emitting a blank label", () => {
    // A blank `event=""` is a distinct series that reads like a bug in the
    // dashboard rather than a fact about the traffic.
    expect(eventLabel(undefined, catalog)).toBe(UNREGISTERED_EVENT_LABEL);
    expect(eventLabel("", catalog)).toBe(UNREGISTERED_EVENT_LABEL);
  });

  it("cannot be widened by a name that merely resembles a registered one", () => {
    expect(eventLabel("page.viewed ", catalog)).toBe(UNREGISTERED_EVENT_LABEL);
    expect(eventLabel("Page.Viewed", catalog)).toBe(UNREGISTERED_EVENT_LABEL);
  });
});

describe("ingest counters carry a bounded event label", () => {
  it("labels an accepted event with its own name", async () => {
    const { handler, metrics, context } = build();
    await handler.handle({ events: [buildEnvelopePayload({ event: "page.viewed" })] }, context);

    expect(
      metrics.getCounter(METRIC_INGEST_BATCH_ACCEPTED_TOTAL, {
        project_id: "checkout",
        environment: "production",
        event: "page.viewed",
      }),
    ).toBe(1);
  });

  it("labels a rejection for an unknown event with the sentinel, not the name", async () => {
    const { handler, metrics, context } = build();
    await handler.handle(
      { events: [buildEnvelopePayload({ event: "attacker.controlled.name" })] },
      context,
    );

    expect(labelsFor(metrics, METRIC_INGEST_BATCH_REJECTED_TOTAL)).toEqual([
      UNREGISTERED_EVENT_LABEL,
    ]);
  });

  it("keeps cardinality flat across many distinct unregistered names", async () => {
    // The property the sentinel exists for, stated as the thing an
    // attacker would try: a hundred different names must not become a
    // hundred series. Asserting the count rather than the values is what
    // makes this fail loudly if the collapse is ever removed.
    const { handler, metrics, context } = build();
    for (let i = 0; i < 100; i++) {
      await handler.handle(
        { events: [buildEnvelopePayload({ event: `made.up.${String(i)}` })] },
        context,
      );
    }

    const series = metrics
      .getSamples()
      .filter((sample) => sample.name === METRIC_INGEST_BATCH_REJECTED_TOTAL);
    expect(series).toHaveLength(1);
    expect(series[0]?.labels["event"]).toBe(UNREGISTERED_EVENT_LABEL);
    expect(series[0]?.value).toBe(100);
  });
});
