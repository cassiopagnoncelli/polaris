/**
 * Tests for the DLQ ledger adapter.
 *
 * `polaris processors dlq list / show / retry` has always read an empty table:
 * the repository behind it works, and nothing wrote through it. A
 * dead-lettered message existed only as bytes on `<component>.dlq`, so the
 * triage runbook's first step found nothing.
 */
import { describe, expect, it } from "vitest";

import { InMemoryProcessorDlqRecordRepository } from "../src/db/processor-dlq-records.js";
import { createDlqLedgerRecorder } from "../src/dlq-ledger.js";

const IDENTITY = { name: "sessionizer", version: "v1" } as const;

function poisonRecord(headers: Record<string, string>) {
  return {
    component: "sessionizer",
    sourceTopic: "raw.events-0",
    sourcePartition: 0,
    sourceOffset: "42",
    attempts: 5,
    reason: "poison_message",
    errorClass: "Error",
    errorMessage: "cannot parse",
    headers,
    value: Buffer.from("{}"),
  };
}

describe("createDlqLedgerRecorder", () => {
  it("writes a row an operator can find by processor", async () => {
    const repository = new InMemoryProcessorDlqRecordRepository();
    const record = createDlqLedgerRecorder({ repository, identity: IDENTITY });

    await record(
      poisonRecord({
        "polaris-event-id": "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
        "polaris-event-name": "page.viewed",
        "polaris-project-id": "storefront",
        "polaris-environment": "development",
      }),
    );

    const rows = await repository.findByProcessor("sessionizer");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_id).toBe("018f1b9e-7b50-7b12-9a2e-0e2f88d8f551");
    expect(rows[0]?.project_id).toBe("storefront");
    expect(rows[0]?.attempts).toBe(5);
    expect(rows[0]?.source_offset).toBe("42");
  });

  it("reads identity from headers, not the payload", async () => {
    // A poison message is by definition one the processor could not handle,
    // so its body may be exactly what fails to parse. Headers are stamped by
    // the producer and survive that.
    const repository = new InMemoryProcessorDlqRecordRepository();
    const record = createDlqLedgerRecorder({ repository, identity: IDENTITY });

    await record({
      ...poisonRecord({ "polaris-project-id": "storefront" }),
      value: Buffer.from("{not json"),
    });

    const rows = await repository.findByProcessor("sessionizer");
    expect(rows[0]?.project_id).toBe("storefront");
    // Absent headers must not blow up the write — a row with `unknown` is far
    // more useful than no row.
    expect(rows[0]?.event_id).toBe("unknown");
  });
});
