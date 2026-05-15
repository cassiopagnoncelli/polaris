import { POLARIS_INGEST_REDACTED_PATTERN_TOTAL } from "@polaris/shared-policy";
import { describe, expect, it } from "vitest";

import {
  IngestMetrics,
  METRIC_INGEST_BATCH_ACCEPTED_TOTAL,
  METRIC_INGEST_DEDUPE_HIT_TOTAL,
  METRIC_INGEST_DEDUPE_SKIPPED_TOTAL,
  METRIC_INGEST_DEPRECATED_SCHEMA_VERSION_TOTAL,
  METRIC_INGEST_PUBLISH_FAILED_TOTAL,
  METRIC_INGEST_PUBLISH_SUCCESS_TOTAL,
} from "../../src/metrics/registry.js";

describe("IngestMetrics", () => {
  it("counts accepted batches per (project_id, environment)", () => {
    const m = new IngestMetrics();
    m.incrementAccepted({ project_id: "p", environment: "prod" });
    m.incrementAccepted({ project_id: "p", environment: "prod" });
    m.incrementAccepted({ project_id: "p", environment: "stage" });
    expect(
      m.getCounter(METRIC_INGEST_BATCH_ACCEPTED_TOTAL, { project_id: "p", environment: "prod" }),
    ).toBe(2);
    expect(
      m.getCounter(METRIC_INGEST_BATCH_ACCEPTED_TOTAL, { project_id: "p", environment: "stage" }),
    ).toBe(1);
  });

  it("counts dedupe hits and skips separately", () => {
    const m = new IngestMetrics();
    m.incrementDedupeHit({ project_id: "p", environment: "prod" });
    m.incrementDedupeSkipped({ project_id: "p", environment: "prod" });
    expect(
      m.getCounter(METRIC_INGEST_DEDUPE_HIT_TOTAL, { project_id: "p", environment: "prod" }),
    ).toBe(1);
    expect(
      m.getCounter(METRIC_INGEST_DEDUPE_SKIPPED_TOTAL, { project_id: "p", environment: "prod" }),
    ).toBe(1);
  });

  it("counts deprecated schema versions", () => {
    const m = new IngestMetrics();
    m.incrementDeprecatedSchemaVersion({ event: "page.viewed", schema_version: 1 });
    m.incrementDeprecatedSchemaVersion({ event: "page.viewed", schema_version: 1 });
    expect(
      m.getCounter(METRIC_INGEST_DEPRECATED_SCHEMA_VERSION_TOTAL, {
        event: "page.viewed",
        schema_version: 1,
      }),
    ).toBe(2);
  });

  it("counts pattern redactions per (project_id, environment, reason, pattern)", () => {
    const m = new IngestMetrics();
    m.incrementPatternRedaction({
      name: POLARIS_INGEST_REDACTED_PATTERN_TOTAL,
      labels: {
        project_id: "p",
        environment: "prod",
        reason: "pii_card",
        pattern: "luhn_pan",
      },
      value: 1,
    });
    expect(
      m.getCounter(POLARIS_INGEST_REDACTED_PATTERN_TOTAL, {
        project_id: "p",
        environment: "prod",
        reason: "pii_card",
        pattern: "luhn_pan",
      }),
    ).toBe(1);
  });

  it("counts publish success and failure per (project_id, environment, topic[, reason])", () => {
    const m = new IngestMetrics();
    m.incrementPublishSuccess({ project_id: "p", environment: "prod", topic: "raw.events" });
    m.incrementPublishSuccess({ project_id: "p", environment: "prod", topic: "raw.events" });
    m.incrementPublishFailed({
      project_id: "p",
      environment: "prod",
      topic: "raw.events",
      reason: "KafkaJSConnectionError",
    });
    expect(
      m.getCounter(METRIC_INGEST_PUBLISH_SUCCESS_TOTAL, {
        project_id: "p",
        environment: "prod",
        topic: "raw.events",
      }),
    ).toBe(2);
    expect(
      m.getCounter(METRIC_INGEST_PUBLISH_FAILED_TOTAL, {
        project_id: "p",
        environment: "prod",
        topic: "raw.events",
        reason: "KafkaJSConnectionError",
      }),
    ).toBe(1);
  });

  it("getSamples returns one sample per unique label tuple", () => {
    const m = new IngestMetrics();
    m.incrementAccepted({ project_id: "p", environment: "prod" });
    m.incrementAccepted({ project_id: "p", environment: "prod" });
    m.incrementAccepted({ project_id: "q", environment: "prod" });
    const accepted = m.getSamples().filter((s) => s.name === METRIC_INGEST_BATCH_ACCEPTED_TOTAL);
    expect(accepted).toHaveLength(2);
  });
});
