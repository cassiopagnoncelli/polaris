import { describe, expect, it } from "vitest";

import {
  CANONICAL_STREAM_FAMILIES,
  dedicatedStreamFamily,
  dlqQueueName,
  isCanonicalStreamFamily,
  parsePartitionStreamName,
  partitionStreamName,
  partitionStreamNames,
  RETRY_BACKOFF_TIERS_MS,
  redeliverQueueName,
  retryExchangeName,
  retryQueueName,
  retryQueueNames,
  retryTierForAttempt,
  STREAM_DIAGNOSTICS_EVENTS,
  STREAM_FAMILY_RAW_EVENTS,
} from "../src/streams.js";

describe("canonical stream constants", () => {
  it("exposes the canonical family names exactly as documented", () => {
    // These string values are part of the architecture contract — changes
    // require coordinated updates in `03-rabbitmq-streams.md`.
    expect(STREAM_FAMILY_RAW_EVENTS).toBe("raw.events");
  });

  it("exposes the SDK diagnostics stream", () => {
    expect(STREAM_DIAGNOSTICS_EVENTS).toBe("polaris.diagnostics.events");
  });

  it("lists every canonical family, including session.events and the spine", () => {
    // `session.events` became canonical with the RabbitMQ migration: the
    // sessionizer always emitted it, but RabbitMQ's topic auto-creation
    // hid the fact that it was never declared anywhere.
    //
    // The three spine families come from the pipeline redesign.
    // Membership is load-bearing beyond this package: `topic_isolations`
    // mirrors this list in a CHECK, so a family missing here cannot be
    // isolated for a project.
    expect(CANONICAL_STREAM_FAMILIES).toEqual([
      "raw.events",
      "identified.events",
      "resolved.events",
      "profile.events",
      "identity.events",
      "session.events",
      "attribution.events",
    ]);
  });
});

describe("isCanonicalStreamFamily", () => {
  it("recognizes canonical families", () => {
    expect(isCanonicalStreamFamily("raw.events")).toBe(true);
    expect(isCanonicalStreamFamily("resolved.events")).toBe(true);
  });

  it("rejects the families retired with the fan-out", () => {
    // 126EPNIQ. The constants still exist -- attribution-engine v1/v2 name
    // them -- so `isCanonicalStreamFamily` is what actually decides whether
    // anything provisions or subscribes to them.
    expect(isCanonicalStreamFamily("analytics.events")).toBe(false);
    expect(isCanonicalStreamFamily("enriched.events")).toBe(false);
  });

  it("rejects unknown values", () => {
    expect(isCanonicalStreamFamily("raw.events.project-x")).toBe(false);
    expect(isCanonicalStreamFamily("polaris.diagnostics.events")).toBe(false);
    expect(isCanonicalStreamFamily("foo")).toBe(false);
  });
});

describe("dedicatedStreamFamily", () => {
  it("builds the family.<project> name", () => {
    expect(dedicatedStreamFamily(STREAM_FAMILY_RAW_EVENTS, "project-alpha")).toBe(
      "raw.events.project-alpha",
    );
  });

  it("rejects empty project_id", () => {
    expect(() => dedicatedStreamFamily(STREAM_FAMILY_RAW_EVENTS, "")).toThrow();
  });
});

describe("partition stream names", () => {
  it("builds <family>-<partition>", () => {
    expect(partitionStreamName("raw.events", 0)).toBe("raw.events-0");
    expect(partitionStreamName("raw.events", 11)).toBe("raw.events-11");
  });

  it("enumerates a super stream in partition order", () => {
    expect(partitionStreamNames("analytics.events", 3)).toEqual([
      "analytics.events-0",
      "analytics.events-1",
      "analytics.events-2",
    ]);
  });

  it("rejects negative or fractional partitions", () => {
    expect(() => partitionStreamName("raw.events", -1)).toThrow();
    expect(() => partitionStreamName("raw.events", 1.5)).toThrow();
    expect(() => partitionStreamNames("raw.events", 0)).toThrow();
  });

  it("round-trips through the parser", () => {
    expect(parsePartitionStreamName("raw.events-2")).toEqual({
      family: "raw.events",
      partition: 2,
    });
    // Dedicated per-project streams carry dots and hyphens in the family.
    expect(parsePartitionStreamName("raw.events.project-alpha-5")).toEqual({
      family: "raw.events.project-alpha",
      partition: 5,
    });
  });

  it("returns undefined for names that are not partition streams", () => {
    expect(parsePartitionStreamName("meta-capi.dlq")).toBeUndefined();
    expect(parsePartitionStreamName("raw.events")).toBeUndefined();
    expect(parsePartitionStreamName("raw.events-")).toBeUndefined();
  });
});

describe("retry / redeliver / dlq queue names", () => {
  it("builds the component queue names", () => {
    expect(retryQueueName("geoip-enricher", 5000)).toBe("geoip-enricher.retry.5000");
    expect(redeliverQueueName("meta-capi")).toBe("meta-capi.redeliver");
    expect(dlqQueueName("identity-resolver")).toBe("identity-resolver.dlq");
    expect(retryExchangeName("ga4")).toBe("ga4.retry.dlx");
  });

  it("enumerates every tier queue", () => {
    expect(retryQueueNames("ga4")).toEqual([
      "ga4.retry.5000",
      "ga4.retry.30000",
      "ga4.retry.120000",
      "ga4.retry.600000",
      "ga4.retry.1800000",
    ]);
  });

  it("rejects an empty component", () => {
    expect(() => retryQueueName("", 5000)).toThrow();
    expect(() => dlqQueueName("")).toThrow();
    expect(() => redeliverQueueName("")).toThrow();
  });

  it("rejects a non-positive tier", () => {
    expect(() => retryQueueName("ga4", 0)).toThrow();
  });
});

describe("retryTierForAttempt", () => {
  it("walks the tiers as attempts climb", () => {
    expect(retryTierForAttempt(1)).toBe(5_000);
    expect(retryTierForAttempt(2)).toBe(30_000);
    expect(retryTierForAttempt(3)).toBe(120_000);
    expect(retryTierForAttempt(4)).toBe(600_000);
    expect(retryTierForAttempt(5)).toBe(1_800_000);
  });

  it("clamps below the first and above the last tier", () => {
    // Attempt 0 should never reach here, but clamping beats throwing on a
    // retry path whose job is to not lose the message.
    expect(retryTierForAttempt(0)).toBe(5_000);
    expect(retryTierForAttempt(99)).toBe(RETRY_BACKOFF_TIERS_MS.at(-1));
  });
});
