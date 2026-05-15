import { describe, expect, it } from "vitest";

import {
  CANONICAL_TOPIC_FAMILIES,
  dedicatedTopicName,
  dlqTopicName,
  isCanonicalTopicFamily,
  retryTopicName,
  TOPIC_DIAGNOSTICS_EVENTS,
  TOPIC_FAMILY_ANALYTICS_EVENTS,
  TOPIC_FAMILY_RAW_EVENTS,
} from "../src/topics.js";

describe("canonical topic constants", () => {
  it("exposes the canonical family names exactly as documented", () => {
    // These string values are part of the architecture contract — changes
    // require coordinated updates in `03-redpanda-topics.md`.
    expect(TOPIC_FAMILY_RAW_EVENTS).toBe("raw.events");
    expect(TOPIC_FAMILY_ANALYTICS_EVENTS).toBe("analytics.events");
  });

  it("exposes the SDK diagnostics topic", () => {
    expect(TOPIC_DIAGNOSTICS_EVENTS).toBe("polaris.diagnostics.events");
  });

  it("lists all five canonical families", () => {
    expect(CANONICAL_TOPIC_FAMILIES).toEqual([
      "raw.events",
      "identity.events",
      "enriched.events",
      "attribution.events",
      "analytics.events",
    ]);
  });
});

describe("isCanonicalTopicFamily", () => {
  it("recognizes canonical families", () => {
    expect(isCanonicalTopicFamily("raw.events")).toBe(true);
    expect(isCanonicalTopicFamily("analytics.events")).toBe(true);
  });

  it("rejects unknown values", () => {
    expect(isCanonicalTopicFamily("raw.events.project-x")).toBe(false);
    expect(isCanonicalTopicFamily("polaris.diagnostics.events")).toBe(false);
    expect(isCanonicalTopicFamily("foo")).toBe(false);
  });
});

describe("dedicatedTopicName", () => {
  it("builds the family.<project> name", () => {
    expect(dedicatedTopicName(TOPIC_FAMILY_RAW_EVENTS, "project-alpha")).toBe(
      "raw.events.project-alpha",
    );
  });

  it("rejects empty project_id", () => {
    expect(() => dedicatedTopicName(TOPIC_FAMILY_RAW_EVENTS, "")).toThrow();
  });
});

describe("retryTopicName / dlqTopicName", () => {
  it("builds retry topics in the documented shape", () => {
    expect(retryTopicName("geoip-enricher")).toBe("geoip-enricher.retry");
    expect(retryTopicName("meta-capi")).toBe("meta-capi.retry");
  });

  it("builds DLQ topics in the documented shape", () => {
    expect(dlqTopicName("identity-resolver")).toBe("identity-resolver.dlq");
    expect(dlqTopicName("ga4")).toBe("ga4.dlq");
  });

  it("rejects empty component names", () => {
    expect(() => retryTopicName("")).toThrow();
    expect(() => dlqTopicName("")).toThrow();
  });
});
