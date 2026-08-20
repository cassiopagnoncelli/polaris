/**
 * Adapter that turns a transport poison callback into a
 * `processor_dlq_records` row.
 *
 * `polaris processors dlq list / show / retry` has always read an empty table.
 * The repository behind it exists and is tested; `publishToDlq` — the helper
 * that would have written through it — has zero call sites, because the
 * transport dead-letters messages through its own lower-level
 * `republishToDlq`, which knows nothing about a ledger.
 *
 * So the bytes reached `<component>.dlq` and nothing else knew. An operator
 * following the DLQ triage runbook found no rows, and a dead-lettered message
 * was discoverable only by draining a queue by hand.
 *
 * This closes that gap from the shared-processor side, where the ledger lives:
 * the transport takes a callback (`PoisonHandle.record`), and this builds one.
 *
 * @see docs/operations/dlq-triage-runbook.md
 */

import {
  POLARIS_HEADER_ENVIRONMENT,
  POLARIS_HEADER_EVENT_ID,
  POLARIS_HEADER_EVENT_NAME,
  POLARIS_HEADER_PROJECT_ID,
  type PoisonRecord,
} from "@polaris/bus";
import type { ProcessorDlqRecordRepository } from "./db/processor-dlq-records.js";
import type { ProcessorIdentity } from "./identity.js";

/** Written when a header the ledger wants is absent from the message. */
const UNKNOWN = "unknown";

export interface CreateDlqLedgerRecorderInput {
  readonly repository: ProcessorDlqRecordRepository;
  readonly identity: ProcessorIdentity;
}

/**
 * Build the `PoisonHandle.record` callback.
 *
 * Reads the canonical identity fields off the message headers rather than
 * decoding the payload: a poison message is by definition one the processor
 * could not handle, so its body may be exactly what cannot be parsed. Headers
 * are stamped by the producer and survive that.
 */
export function createDlqLedgerRecorder(
  input: CreateDlqLedgerRecorderInput,
): (record: PoisonRecord) => Promise<void> {
  return async (record: PoisonRecord): Promise<void> => {
    await input.repository.recordDlq({
      processor_name: input.identity.name,
      processor_version: input.identity.version,
      event_id: record.headers[POLARIS_HEADER_EVENT_ID] ?? UNKNOWN,
      event_name: record.headers[POLARIS_HEADER_EVENT_NAME] ?? UNKNOWN,
      project_id: record.headers[POLARIS_HEADER_PROJECT_ID] ?? UNKNOWN,
      environment: record.headers[POLARIS_HEADER_ENVIRONMENT] ?? UNKNOWN,
      attempts: record.attempts,
      reason: record.reason,
      error_class: record.errorClass,
      error_message: record.errorMessage,
      source_topic: record.sourceTopic,
      source_partition: record.sourcePartition,
      source_offset: record.sourceOffset,
      headers: record.headers,
      payload: record.value ?? null,
    });
  };
}
