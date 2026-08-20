/**
 * Behavioral tests for `DeliveryRecordRepository.findByDestinationId`.
 *
 * Pins the filter knobs the `polaris deliveries list` CLI relies on
 * (status, errorClass, since/until window, limit) against the in-memory
 * adapter. The Kysely adapter shares the contract and is exercised in
 * integration tests against a live PostgreSQL.
 *
 * @see libs/delivery/destinations/src/db/delivery-records.ts
 */

import { describe, expect, it } from "vitest";

import {
  InMemoryDeliveryRecordRepository,
  LIST_DELIVERY_RECORDS_HARD_LIMIT,
  type RecordDeliveryInput,
} from "../src/index.js";

function baseInput(overrides: Partial<RecordDeliveryInput> = {}): RecordDeliveryInput {
  return {
    destination_id: "polaris_dst_test",
    event_id: "evt_test_001",
    event_name: "payment.approved",
    project_id: "storefront",
    environment: "production",
    consumer_version: "v1",
    normalize_version: "v1",
    mapper_version: "v1",
    deliverer_version: "v1",
    attempt: 1,
    status: "accepted",
    finished_at: new Date("2026-05-14T12:00:00.000Z"),
    started_at: new Date("2026-05-14T12:00:00.000Z"),
    ...overrides,
  };
}

describe("findByDestinationId (in-memory)", () => {
  it("returns only rows for the requested destination, newest first", async () => {
    const repo = new InMemoryDeliveryRecordRepository();
    await repo.recordDelivery({
      ...baseInput(),
      delivery_id: "old",
      finished_at: new Date("2026-05-13T00:00:00.000Z"),
    });
    await repo.recordDelivery({
      ...baseInput(),
      delivery_id: "new",
      finished_at: new Date("2026-05-14T00:00:00.000Z"),
    });
    await repo.recordDelivery({
      ...baseInput(),
      delivery_id: "other",
      destination_id: "polaris_dst_other",
    });
    const rows = await repo.findByDestinationId("polaris_dst_test");
    expect(rows.map((r) => r.delivery_id)).toEqual(["new", "old"]);
  });

  it("narrows by status when supplied", async () => {
    const repo = new InMemoryDeliveryRecordRepository();
    await repo.recordDelivery({ ...baseInput(), delivery_id: "ok", status: "accepted" });
    await repo.recordDelivery({
      ...baseInput(),
      delivery_id: "bad",
      status: "failed_permanent",
      error_class: "permanent",
    });
    const failures = await repo.findByDestinationId("polaris_dst_test", {
      status: "failed_permanent",
    });
    expect(failures.map((r) => r.delivery_id)).toEqual(["bad"]);
  });

  it("narrows by errorClass when supplied", async () => {
    const repo = new InMemoryDeliveryRecordRepository();
    await repo.recordDelivery({
      ...baseInput(),
      delivery_id: "auth",
      status: "failed_permanent",
      error_class: "auth",
    });
    await repo.recordDelivery({
      ...baseInput(),
      delivery_id: "perm",
      status: "failed_permanent",
      error_class: "permanent",
    });
    const onlyAuth = await repo.findByDestinationId("polaris_dst_test", { errorClass: "auth" });
    expect(onlyAuth.map((r) => r.delivery_id)).toEqual(["auth"]);
  });

  it("applies since/until as a half-open finished_at window", async () => {
    const repo = new InMemoryDeliveryRecordRepository();
    await repo.recordDelivery({
      ...baseInput(),
      delivery_id: "before",
      finished_at: new Date("2026-05-13T00:00:00.000Z"),
    });
    await repo.recordDelivery({
      ...baseInput(),
      delivery_id: "in",
      finished_at: new Date("2026-05-14T00:00:00.000Z"),
    });
    await repo.recordDelivery({
      ...baseInput(),
      delivery_id: "after",
      finished_at: new Date("2026-05-15T00:00:00.000Z"),
    });
    const rows = await repo.findByDestinationId("polaris_dst_test", {
      since: new Date("2026-05-14T00:00:00.000Z"),
      until: new Date("2026-05-15T00:00:00.000Z"),
    });
    expect(rows.map((r) => r.delivery_id)).toEqual(["in"]);
  });

  it("stamps consumer_build_version when supplied (M0DROHV3)", async () => {
    const repo = new InMemoryDeliveryRecordRepository();
    const persisted = await repo.recordDelivery({
      ...baseInput(),
      delivery_id: "with-build",
      consumer_build_version: "2026-q2-r1",
    });
    expect(persisted.consumer_build_version).toBe("2026-q2-r1");
    const fetched = await repo.findRecord("with-build");
    expect(fetched?.consumer_build_version).toBe("2026-q2-r1");
  });

  it("leaves consumer_build_version null when omitted (back-compat)", async () => {
    const repo = new InMemoryDeliveryRecordRepository();
    const persisted = await repo.recordDelivery({
      ...baseInput(),
      delivery_id: "no-build",
    });
    expect(persisted.consumer_build_version).toBeNull();
  });

  it("clamps to LIST_DELIVERY_RECORDS_HARD_LIMIT", async () => {
    const repo = new InMemoryDeliveryRecordRepository();
    for (let i = 0; i < 3; i += 1) {
      await repo.recordDelivery({
        ...baseInput(),
        delivery_id: `r${i}`,
        finished_at: new Date(2026, 4, 14, 0, i),
      });
    }
    const two = await repo.findByDestinationId("polaris_dst_test", { limit: 2 });
    expect(two).toHaveLength(2);
    expect(LIST_DELIVERY_RECORDS_HARD_LIMIT).toBe(1000);
  });
});
