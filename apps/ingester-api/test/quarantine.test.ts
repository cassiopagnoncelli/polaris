/**
 * The quarantine hook.
 *
 * Two properties, tested apart because they fail apart: the record is
 * safe (no raw payload, right scope), and the hook is actually WIRED to
 * the rejection path and stays out of its way when the broker is gone.
 *
 * The second half is the one this repo keeps shipping missing — a
 * mechanism built, tested in isolation, and connected to nothing.
 */

import type { PolarisProducer } from "@polaris/shared-transport";
import { describe, expect, it, vi } from "vitest";

import {
  buildViolationRecord,
  createQuarantinePublisher,
  type QuarantineCandidate,
} from "../src/ingest/quarantine.js";

const PAN = "4111111111111111";
const NOW = new Date("2026-08-15T12:00:00.000Z");

function candidate(overrides: Partial<QuarantineCandidate> = {}): QuarantineCandidate {
  return {
    raw: { event: "purchase", properties: { cvv: "123", total: 12.5 } },
    rejected: {
      event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
      status: "rejected",
      code: "forbidden_field_rejected",
      retryable: false,
      detail: { path: ["properties", "cvv"], policy_reason: "pii_card" },
    },
    projectId: "storefront",
    environment: "production",
    ...overrides,
  };
}

function recordingProducer(): PolarisProducer & { readonly published: Buffer[] } {
  const published: Buffer[] = [];
  return {
    published,
    publish: async (input: { value: Buffer }) => {
      published.push(input.value);
      return { stream: "rejected.events-0", partition: 0 };
    },
  } as unknown as PolarisProducer & { readonly published: Buffer[] };
}

describe("buildViolationRecord", () => {
  it("carries reason, paths and a redacted sample — never the raw value", () => {
    const record = buildViolationRecord(candidate(), NOW, "polaris_vio_1");

    expect(record.reason).toBe("forbidden_field_rejected");
    expect(record.paths).toEqual(["properties.cvv"]);
    expect(record.redacted_sample).not.toContain('"123"');
    expect(record.redacted_sample).toContain("REDACTED");
    // The shape a producer needs to debug survives.
    expect(record.redacted_sample).toContain("12.5");
  });

  it("takes the project from the API key tuple, not from the payload", () => {
    // A rejected event's self-reported project is exactly the kind of
    // thing that may be wrong, and a violation filed under a project's
    // name by an unrelated producer is worse than no violation.
    const record = buildViolationRecord(
      candidate({
        raw: { event: "purchase", project_id: "someone-else", properties: { cvv: "1" } },
      }),
      NOW,
      "polaris_vio_1",
    );

    expect(record.project_id).toBe("storefront");
  });

  it("records null for hints a rejected payload never supplied", () => {
    const record = buildViolationRecord(
      candidate({
        raw: { properties: { cvv: "1" } },
        rejected: {
          event_id: "",
          status: "rejected",
          code: "invalid_envelope",
          retryable: false,
        },
      }),
      NOW,
      "polaris_vio_1",
    );

    expect(record.event).toBeNull();
    expect(record.event_id).toBeNull();
    expect(record.schema_version).toBeNull();
  });

  it("falls back to the payload's event_id hint when the rejection has none", () => {
    const record = buildViolationRecord(
      candidate({
        raw: { event: "purchase", event_id: "hint-id", properties: { cvv: "1" } },
        rejected: { event_id: "", status: "rejected", code: "invalid_envelope", retryable: false },
      }),
      NOW,
      "polaris_vio_1",
    );

    expect(record.event_id).toBe("hint-id");
  });

  it("carries no paths when the rejection named none", () => {
    const record = buildViolationRecord(
      candidate({
        rejected: { event_id: "x", status: "rejected", code: "unknown_event", retryable: false },
      }),
      NOW,
      "polaris_vio_1",
    );

    expect(record.paths).toEqual([]);
  });

  it("versions itself independently of the envelope", () => {
    expect(buildViolationRecord(candidate(), NOW, "v").violation_version).toBe(1);
  });
});

describe("createQuarantinePublisher", () => {
  it("publishes one record per rejection, keyed by project", async () => {
    const producer = recordingProducer();
    const publishSpy = vi.spyOn(producer, "publish");
    const publisher = createQuarantinePublisher({
      producer,
      now: () => NOW,
      generateId: () => "polaris_vio_1",
    });

    await publisher.publish([candidate(), candidate()]);

    expect(producer.published).toHaveLength(2);
    expect(publishSpy.mock.calls[0]?.[0]).toMatchObject({
      family: "rejected.events",
      // One project's violations stay on one partition, so a per-project
      // rate is visible as a partition's rate.
      partitionKey: "storefront:production",
    });
  });

  it("publishes a parseable violation record", async () => {
    const producer = recordingProducer();
    const publisher = createQuarantinePublisher({ producer, now: () => NOW });

    await publisher.publish([candidate()]);

    const parsed = JSON.parse(producer.published[0]?.toString("utf8") ?? "{}") as Record<
      string,
      unknown
    >;
    expect(parsed["reason"]).toBe("forbidden_field_rejected");
    expect(parsed["received_at"]).toBe("2026-08-15T12:00:00.000Z");
    expect(JSON.stringify(parsed)).not.toContain(PAN);
  });

  it("swallows a broker failure and counts it", async () => {
    // Fail-open. An ingester that threw because the QUARANTINE was down
    // would convert a working rejection into an outage, for a diagnostic
    // about an event that was being rejected anyway.
    const failures: string[] = [];
    const publisher = createQuarantinePublisher({
      producer: {
        publish: async () => {
          throw new Error("broker down");
        },
      } as unknown as PolarisProducer,
      now: () => NOW,
      onFailed: ({ reason }) => failures.push(reason),
    });

    await expect(publisher.publish([candidate()])).resolves.toBeUndefined();
    expect(failures).toEqual(["forbidden_field_rejected"]);
  });

  it("keeps going after one record fails", async () => {
    // A single oversized or unroutable record must not silently drop the
    // rest of the batch's violations.
    let calls = 0;
    const published: Buffer[] = [];
    const publisher = createQuarantinePublisher({
      producer: {
        publish: async (input: { value: Buffer }) => {
          calls += 1;
          if (calls === 1) throw new Error("first one fails");
          published.push(input.value);
          return { stream: "rejected.events-0", partition: 0 };
        },
      } as unknown as PolarisProducer,
      now: () => NOW,
    });

    await publisher.publish([candidate(), candidate()]);

    expect(published).toHaveLength(1);
  });
});
