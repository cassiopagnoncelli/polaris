/**
 * Smoke tests for the public surface of `@polaris/shared-destinations`.
 *
 * Deep behavioral coverage (consent + retry + DLQ + delivery_records
 * round-trips) is owned by the follow-up task that completes the
 * vendor-consumer test matrix once the first vendor wraps the runtime
 * (P9-002 webhook-sink). These smoke tests pin the public API so the
 * package keeps its shape across future refactors.
 *
 * @see docs/implementation/tasks/P9-001-destination-consumer-runtime.md
 */

import { describe, expect, it } from "vitest";

import {
  applyReplayPolicy,
  buildDeliveryKey,
  createDestinationConsumer,
  DELIVERY_KEY_PREFIX,
  DELIVERY_RECORD_ERROR_CLASSES,
  DELIVERY_RECORD_STATUSES,
  DestinationInstanceCache,
  DestinationMetrics,
  DestinationRateLimiter,
  InMemoryDeliveryRecordRepository,
  InMemoryDestinationDedupe,
  InMemoryDestinationInstanceReader,
  isDeliveryRecordErrorClass,
  isDeliveryRecordStatus,
  METRIC_DESTINATION_EVENTS_CONSUMED_TOTAL,
  POLARIS_HEADER_DESTINATION_ID,
  POLARIS_HEADER_REPLAY,
  publishToDestinationDlq,
  readReplayContext,
  truncateSummary,
  VENDOR_RESPONSE_SUMMARY_MAX_LENGTH,
} from "../src/index.js";

describe("@polaris/shared-destinations public surface", () => {
  it("re-exports the closed sets used by the runtime", () => {
    expect(DELIVERY_RECORD_STATUSES).toContain("delivered");
    expect(DELIVERY_RECORD_STATUSES).toContain("dropped_consent");
    expect(DELIVERY_RECORD_STATUSES).toContain("failed_permanent");
    expect(DELIVERY_RECORD_ERROR_CLASSES).toContain("transient");
    expect(DELIVERY_RECORD_ERROR_CLASSES).toContain("permanent");
  });

  it("status guard accepts known values and rejects unknown ones", () => {
    expect(isDeliveryRecordStatus("delivered")).toBe(true);
    expect(isDeliveryRecordStatus("does_not_exist")).toBe(false);
  });

  it("error-class guard accepts known values and rejects unknown ones", () => {
    expect(isDeliveryRecordErrorClass("transient")).toBe(true);
    expect(isDeliveryRecordErrorClass("does_not_exist")).toBe(false);
  });

  it("exposes the Prometheus metric names used by P10-002", () => {
    expect(METRIC_DESTINATION_EVENTS_CONSUMED_TOTAL).toBe(
      "polaris_destination_events_consumed_total",
    );
  });

  it("exposes the wire headers the runtime stamps onto Kafka messages", () => {
    expect(POLARIS_HEADER_DESTINATION_ID).toBe("polaris-destination-id");
    expect(POLARIS_HEADER_REPLAY).toBe("polaris-replay");
  });

  it("buildDeliveryKey uses the documented prefix", () => {
    const key = buildDeliveryKey({
      destination_id: "polaris_dst_test",
      event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
      identity: {
        vendor: "test",
        consumerVersion: "v1",
        normalizeVersion: "v1",
        mapperVersion: "v1",
        delivererVersion: "v1",
      },
    });
    expect(key.startsWith(DELIVERY_KEY_PREFIX)).toBe(true);
  });

  it("readReplayContext defaults to non-replay when headers are absent", () => {
    const ctx = readReplayContext(undefined);
    expect(ctx.is_replay).toBe(false);
  });

  it("applyReplayPolicy refuses replays when the destination opts out", () => {
    const decision = applyReplayPolicy({ is_replay: true, replay_job_id: "polaris_rpj_x" }, false);
    expect(decision.kind).toBe("suppress");
  });

  it("truncateSummary clamps to VENDOR_RESPONSE_SUMMARY_MAX_LENGTH", () => {
    const big = "x".repeat(VENDOR_RESPONSE_SUMMARY_MAX_LENGTH * 2);
    const result = truncateSummary(big);
    expect(result === null || result.length <= VENDOR_RESPONSE_SUMMARY_MAX_LENGTH).toBe(true);
  });

  it("DestinationMetrics is instantiable and exposes samples", () => {
    const m = new DestinationMetrics();
    m.incrementConsumed({
      vendor: "test",
      consumer_version: "v1",
      destination_id: "polaris_dst_smoke",
      project_id: "p1",
      environment: "development",
    });
    expect(m.getSamples().length).toBeGreaterThan(0);
  });

  it("constructors / factories are callable without throwing", () => {
    expect(() => new InMemoryDeliveryRecordRepository()).not.toThrow();
    expect(() => new InMemoryDestinationInstanceReader([])).not.toThrow();
    expect(() => new InMemoryDestinationDedupe()).not.toThrow();
    expect(() => new DestinationRateLimiter()).not.toThrow();
    expect(typeof createDestinationConsumer).toBe("function");
    expect(typeof publishToDestinationDlq).toBe("function");
    expect(DestinationInstanceCache).toBeDefined();
  });
});
