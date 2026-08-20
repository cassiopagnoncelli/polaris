/**
 * Typed Kysely view of the `dlq_records` table plus repository helpers.
 *
 * The table is created by
 * `db/postgres/migrations/20260514000001_create_dlq_records.sql` (P9-007). This
 * module:
 *
 *   1. Mirrors the SQL schema as a `DlqRecordsTable` interface.
 *   2. Extends `@polaris/persistence-postgres`'s `Database` interface via module
 *      augmentation so any `Kysely<Database>` instance in the runtime
 *      gets `db.selectFrom("dlq_records")` typed automatically.
 *   3. Exposes a small `DlqRecordRepository` contract with an in-memory
 *      adapter (tests / bootstrap) and a Kysely-backed adapter (production).
 *   4. Provides `markResolved` semantics that idempotently mark a row as
 *      resolved or report "already resolved" without overwriting.
 *
 * Hard rules baked into this module (mirror `delivery_records`):
 *
 *   - No column resembling a credential. This mattered more once
 *     `destinations.secret_value` began holding the vendor credential
 *     itself rather than a `<provider>:<ref>` pointer: a DLQ row outlives
 *     the delivery that produced it and is read during triage by whoever
 *     is on call. The runtime never stamps one here.
 *
 *   - `vendor_response_summary` is capped at 1 KB at the application
 *     layer (same as `delivery_records`). The repository truncates on
 *     insert.
 *
 *   - `resolution_note` is capped at 1 KB at the application layer.
 *
 *   - `dlq_id` is UUIDv7 with the `polaris_dlq_` prefix. The repository
 *     allocates one when the caller omits it.
 *
 * @see db/postgres/migrations/20260514000001_create_dlq_records.sql
 * @see docs/architecture/06-destinations.md "Retry and DLQ Policy"
 */

import type { Database } from "@polaris/persistence-postgres";
import type { ColumnType, Kysely } from "kysely";
import { v7 as uuidv7 } from "uuid";

import {
  type DeliveryRecordErrorClass,
  isDeliveryRecordErrorClass,
  truncateSummary,
} from "./delivery-records.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Prefix stamped on every DLQ record id. */
export const DLQ_RECORD_ID_PREFIX = "polaris_dlq_" as const;

/** Maximum number of rows `findUnresolved`/`findByDestinationId` will return. */
export const LIST_DLQ_RECORDS_HARD_LIMIT = 1000 as const;

/** Application-layer cap on `resolution_note` length (matches CHECK). */
export const DLQ_RESOLUTION_NOTE_MAX_LENGTH = 1024;

// ---------------------------------------------------------------------------
// Typed table mirror
// ---------------------------------------------------------------------------

/**
 * Typed mirror of the `dlq_records` table.
 *
 * Extends `@polaris/persistence-postgres`'s `Database` interface via module
 * augmentation so any `Kysely<Database>` instance in the runtime gets
 * `db.selectFrom("dlq_records")` typed automatically.
 */
export interface DlqRecordsTable {
  dlq_id: string;
  destination_id: string;
  event_id: string;
  event_name: string;
  project_id: string;
  environment: string;
  vendor: string;
  consumer_version: string;
  normalize_version: string;
  mapper_version: string;
  deliverer_version: string;
  attempts: ColumnType<number, number | undefined, number>;
  reason: string;
  error_class: ColumnType<
    DeliveryRecordErrorClass | null,
    DeliveryRecordErrorClass | null | undefined,
    DeliveryRecordErrorClass | null
  >;
  vendor_response_code: ColumnType<string | null, string | null | undefined, string | null>;
  vendor_response_summary: ColumnType<string | null, string | null | undefined, string | null>;
  delivery_key: ColumnType<string | null, string | null | undefined, string | null>;
  source_topic: string;
  source_partition: number;
  source_offset: string;
  headers: ColumnType<
    Record<string, string>,
    Record<string, string> | string | undefined,
    Record<string, string> | string
  >;
  payload: ColumnType<Buffer | null, Buffer | null | undefined, Buffer | null>;
  published_at: ColumnType<Date, Date | string | undefined, Date | string>;
  resolved_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  resolved_by: ColumnType<string | null, string | null | undefined, string | null>;
  resolution_note: ColumnType<string | null, string | null | undefined, string | null>;
}

declare module "@polaris/persistence-postgres" {
  interface Database {
    dlq_records: DlqRecordsTable;
  }
}

// ---------------------------------------------------------------------------
// Application-layer record + insert input
// ---------------------------------------------------------------------------

/**
 * Read-shape returned by `DlqRecordRepository.findRecord` / `findUnresolved`
 * / `recordDlq`. Plain JS types: timestamps as Date; headers as a plain
 * record; payload as a Node `Buffer` (or `null` if missing).
 */
export interface DlqRecord {
  readonly dlq_id: string;
  readonly destination_id: string;
  readonly event_id: string;
  readonly event_name: string;
  readonly project_id: string;
  readonly environment: string;
  readonly vendor: string;
  readonly consumer_version: string;
  readonly normalize_version: string;
  readonly mapper_version: string;
  readonly deliverer_version: string;
  readonly attempts: number;
  readonly reason: string;
  readonly error_class: DeliveryRecordErrorClass | null;
  readonly vendor_response_code: string | null;
  readonly vendor_response_summary: string | null;
  readonly delivery_key: string | null;
  readonly source_topic: string;
  readonly source_partition: number;
  readonly source_offset: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly payload: Buffer | null;
  readonly published_at: Date;
  readonly resolved_at: Date | null;
  readonly resolved_by: string | null;
  readonly resolution_note: string | null;
}

/**
 * Input accepted by `recordDlq`. Most fields mirror `DlqRecord`; `dlq_id` is
 * optional (the repository allocates a `polaris_dlq_<uuidv7>` value when
 * omitted) and `published_at` defaults to `now()`. Resolution slots
 * (`resolved_at`, `resolved_by`, `resolution_note`) MUST be absent on
 * insert — they only get set via `markResolved`.
 */
export interface RecordDlqInput {
  readonly dlq_id?: string;
  readonly destination_id: string;
  readonly event_id: string;
  readonly event_name: string;
  readonly project_id: string;
  readonly environment: string;
  readonly vendor: string;
  readonly consumer_version: string;
  readonly normalize_version: string;
  readonly mapper_version: string;
  readonly deliverer_version: string;
  readonly attempts: number;
  readonly reason: string;
  readonly error_class?: DeliveryRecordErrorClass | null;
  readonly vendor_response_code?: string | null;
  readonly vendor_response_summary?: string | null;
  readonly delivery_key?: string | null;
  readonly source_topic: string;
  readonly source_partition: number;
  readonly source_offset: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly payload?: Buffer | null;
  readonly published_at?: Date;
}

/**
 * Outcome of `markResolved`. `applied: true` means the row transitioned
 * to resolved on this call; `applied: false` means the row was already
 * resolved when the caller looked it up.
 */
export interface MarkResolvedOutcome {
  readonly applied: boolean;
  readonly record: DlqRecord;
}

/**
 * Filters accepted by `findByDestinationId` / `findByVendor`. Each is
 * optional; the repository applies the ones that are set and ignores the
 * rest.
 *
 *   - `errorClass`    narrow to one error_class label
 *   - `reason`        narrow to one classification reason
 *   - `since` / `until`
 *                     half-open published-at window
 *   - `includeResolved`
 *                     when false (default), only unresolved rows are
 *                     returned — matches the active-triage workflow
 *   - `limit`         max rows; the repository caps at
 *                     `LIST_DLQ_RECORDS_HARD_LIMIT`
 */
export interface ListDlqRecordsFilter {
  readonly errorClass?: DeliveryRecordErrorClass;
  readonly reason?: string;
  readonly since?: Date;
  readonly until?: Date;
  readonly includeResolved?: boolean;
  readonly limit?: number;
}

/** Repository contract. Implementations: in-memory + Kysely. */
export interface DlqRecordRepository {
  /** Insert one DLQ record. Returns the persisted row. */
  recordDlq(input: RecordDlqInput): Promise<DlqRecord>;
  /** Read one record by id. Returns `null` when not found. */
  findRecord(dlq_id: string): Promise<DlqRecord | null>;
  /**
   * List records for an `event_id`, newest first.
   *
   * The triage commands read by destination or vendor because that is how
   * an operator asks "what is failing". `polaris events trace` asks the
   * other question — "what happened to this one event" — and one event
   * can be dead-lettered by several destinations independently, so this
   * returns a list, not a row.
   */
  findByEventId(event_id: string): Promise<readonly DlqRecord[]>;
  /** List records for a destination_id, newest first, with filter knobs. */
  findByDestinationId(
    destination_id: string,
    filter?: ListDlqRecordsFilter,
  ): Promise<readonly DlqRecord[]>;
  /** List records for a vendor, newest first, with filter knobs. */
  findByVendor(vendor: string, filter?: ListDlqRecordsFilter): Promise<readonly DlqRecord[]>;
  /**
   * Mark one record resolved. Idempotent: returns `applied: false` when
   * the row was already resolved. Throws when the id is unknown.
   */
  markResolved(
    dlq_id: string,
    resolvedBy: string,
    note: string | null,
    resolvedAt?: Date,
  ): Promise<MarkResolvedOutcome>;
}

// ---------------------------------------------------------------------------
// In-memory adapter
// ---------------------------------------------------------------------------

/** Options accepted by the in-memory adapter. */
export interface InMemoryDlqRecordRepositoryOptions {
  readonly now?: () => Date;
}

/**
 * Pure in-memory `DlqRecordRepository`. Suitable for unit tests and the
 * smoke harness.
 */
export class InMemoryDlqRecordRepository implements DlqRecordRepository {
  private readonly records = new Map<string, DlqRecord>();
  private readonly now: () => Date;

  constructor(options: InMemoryDlqRecordRepositoryOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async recordDlq(input: RecordDlqInput): Promise<DlqRecord> {
    const dlq_id = input.dlq_id ?? `${DLQ_RECORD_ID_PREFIX}${uuidv7()}`;
    const record: DlqRecord = {
      dlq_id,
      destination_id: input.destination_id,
      event_id: input.event_id,
      event_name: input.event_name,
      project_id: input.project_id,
      environment: input.environment,
      vendor: input.vendor,
      consumer_version: input.consumer_version,
      normalize_version: input.normalize_version,
      mapper_version: input.mapper_version,
      deliverer_version: input.deliverer_version,
      attempts: input.attempts,
      reason: input.reason,
      error_class: input.error_class ?? null,
      vendor_response_code: input.vendor_response_code ?? null,
      vendor_response_summary: truncateSummary(input.vendor_response_summary),
      delivery_key: input.delivery_key ?? null,
      source_topic: input.source_topic,
      source_partition: input.source_partition,
      source_offset: input.source_offset,
      headers: { ...(input.headers ?? {}) },
      payload: input.payload ?? null,
      published_at: input.published_at ?? this.now(),
      resolved_at: null,
      resolved_by: null,
      resolution_note: null,
    };
    this.records.set(dlq_id, record);
    return record;
  }

  async findRecord(dlq_id: string): Promise<DlqRecord | null> {
    return this.records.get(dlq_id) ?? null;
  }

  async findByEventId(event_id: string): Promise<readonly DlqRecord[]> {
    // Resolved records included — see the Kysely adapter for why.
    return filterAndSlice(
      Array.from(this.records.values()),
      { includeResolved: true },
      (r) => r.event_id === event_id,
    );
  }

  async findByDestinationId(
    destination_id: string,
    filter: ListDlqRecordsFilter = {},
  ): Promise<readonly DlqRecord[]> {
    return filterAndSlice(
      Array.from(this.records.values()),
      filter,
      (r) => r.destination_id === destination_id,
    );
  }

  async findByVendor(
    vendor: string,
    filter: ListDlqRecordsFilter = {},
  ): Promise<readonly DlqRecord[]> {
    return filterAndSlice(Array.from(this.records.values()), filter, (r) => r.vendor === vendor);
  }

  async markResolved(
    dlq_id: string,
    resolvedBy: string,
    note: string | null,
    resolvedAt?: Date,
  ): Promise<MarkResolvedOutcome> {
    const existing = this.records.get(dlq_id);
    if (existing === undefined) {
      throw new Error(`dlq_records: id "${dlq_id}" not found`);
    }
    if (existing.resolved_at !== null) {
      return { applied: false, record: existing };
    }
    const updated: DlqRecord = {
      ...existing,
      resolved_at: resolvedAt ?? this.now(),
      resolved_by: resolvedBy,
      resolution_note: clampNote(note),
    };
    this.records.set(dlq_id, updated);
    return { applied: true, record: updated };
  }

  /** Snapshot every record. Useful for tests. */
  snapshot(): readonly DlqRecord[] {
    return Array.from(this.records.values());
  }

  /** Clear the store. Useful for tests. */
  clear(): void {
    this.records.clear();
  }
}

// ---------------------------------------------------------------------------
// Kysely-backed adapter
// ---------------------------------------------------------------------------

/** Options accepted by the SQL-backed adapter. */
export interface KyselyDlqRecordRepositoryOptions {
  readonly db: Kysely<Database>;
  readonly now?: () => Date;
}

/** Build a Kysely-backed `DlqRecordRepository`. */
export function createKyselyDlqRecordRepository(
  options: KyselyDlqRecordRepositoryOptions,
): DlqRecordRepository {
  const { db } = options;
  const now = options.now ?? (() => new Date());

  async function recordDlq(input: RecordDlqInput): Promise<DlqRecord> {
    const dlq_id = input.dlq_id ?? `${DLQ_RECORD_ID_PREFIX}${uuidv7()}`;
    const published_at = input.published_at ?? now();
    const inserted = await db
      .insertInto("dlq_records")
      .values({
        dlq_id,
        destination_id: input.destination_id,
        event_id: input.event_id,
        event_name: input.event_name,
        project_id: input.project_id,
        environment: input.environment,
        vendor: input.vendor,
        consumer_version: input.consumer_version,
        normalize_version: input.normalize_version,
        mapper_version: input.mapper_version,
        deliverer_version: input.deliverer_version,
        attempts: input.attempts,
        reason: input.reason,
        error_class: input.error_class ?? null,
        vendor_response_code: input.vendor_response_code ?? null,
        vendor_response_summary: truncateSummary(input.vendor_response_summary),
        delivery_key: input.delivery_key ?? null,
        source_topic: input.source_topic,
        source_partition: input.source_partition,
        source_offset: input.source_offset,
        headers: JSON.stringify(input.headers ?? {}),
        payload: input.payload ?? null,
        published_at,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRecord(inserted);
  }

  async function findRecord(dlq_id: string): Promise<DlqRecord | null> {
    const row = await db
      .selectFrom("dlq_records")
      .selectAll()
      .where("dlq_id", "=", dlq_id)
      .executeTakeFirst();
    return row === undefined ? null : toRecord(row);
  }

  async function findByEventId(event_id: string): Promise<readonly DlqRecord[]> {
    // `includeResolved: true` — a trace reports history, not a work
    // queue. "This event was dead-lettered and someone fixed it" is the
    // answer an operator is looking for; hiding the row because it was
    // resolved would report the event as having sailed through.
    const rows = await applyFilter(
      db.selectFrom("dlq_records").selectAll().where("event_id", "=", event_id),
      { includeResolved: true },
    )
      .orderBy("published_at", "desc")
      .execute();
    return rows.map(toRecord);
  }

  async function findByDestinationId(
    destination_id: string,
    filter: ListDlqRecordsFilter = {},
  ): Promise<readonly DlqRecord[]> {
    const rows = await applyFilter(
      db.selectFrom("dlq_records").selectAll().where("destination_id", "=", destination_id),
      filter,
    )
      .orderBy("published_at", "desc")
      .limit(clampListLimit(filter.limit))
      .execute();
    return rows.map(toRecord);
  }

  async function findByVendor(
    vendor: string,
    filter: ListDlqRecordsFilter = {},
  ): Promise<readonly DlqRecord[]> {
    const rows = await applyFilter(
      db.selectFrom("dlq_records").selectAll().where("vendor", "=", vendor),
      filter,
    )
      .orderBy("published_at", "desc")
      .limit(clampListLimit(filter.limit))
      .execute();
    return rows.map(toRecord);
  }

  async function markResolved(
    dlq_id: string,
    resolvedBy: string,
    note: string | null,
    resolvedAt?: Date,
  ): Promise<MarkResolvedOutcome> {
    const existing = await db
      .selectFrom("dlq_records")
      .selectAll()
      .where("dlq_id", "=", dlq_id)
      .executeTakeFirst();
    if (existing === undefined) {
      throw new Error(`dlq_records: id "${dlq_id}" not found`);
    }
    const existingRecord = toRecord(existing);
    if (existingRecord.resolved_at !== null) {
      return { applied: false, record: existingRecord };
    }
    const updatedAt = resolvedAt ?? now();
    const updated = await db
      .updateTable("dlq_records")
      .set({
        resolved_at: updatedAt,
        resolved_by: resolvedBy,
        resolution_note: clampNote(note),
      })
      .where("dlq_id", "=", dlq_id)
      .where("resolved_at", "is", null)
      .returningAll()
      .executeTakeFirst();
    if (updated === undefined) {
      // Lost the race — someone else resolved it.
      const after = await db
        .selectFrom("dlq_records")
        .selectAll()
        .where("dlq_id", "=", dlq_id)
        .executeTakeFirstOrThrow();
      return { applied: false, record: toRecord(after) };
    }
    return { applied: true, record: toRecord(updated) };
  }

  return {
    recordDlq,
    findRecord,
    findByEventId,
    findByDestinationId,
    findByVendor,
    markResolved,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Truncate `resolution_note` to the CHECK-constrained max length. */
function clampNote(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (value.length === 0) return null;
  if (value.length <= DLQ_RESOLUTION_NOTE_MAX_LENGTH) return value;
  return `${value.slice(0, DLQ_RESOLUTION_NOTE_MAX_LENGTH - 1)}…`;
}

function clampListLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return LIST_DLQ_RECORDS_HARD_LIMIT;
  }
  return Math.min(Math.floor(value), LIST_DLQ_RECORDS_HARD_LIMIT);
}

function filterAndSlice(
  rows: readonly DlqRecord[],
  filter: ListDlqRecordsFilter,
  pred: (r: DlqRecord) => boolean,
): readonly DlqRecord[] {
  const matches: DlqRecord[] = [];
  const includeResolved = filter.includeResolved ?? false;
  for (const record of rows) {
    if (!pred(record)) continue;
    if (!includeResolved && record.resolved_at !== null) continue;
    if (filter.errorClass !== undefined && record.error_class !== filter.errorClass) continue;
    if (filter.reason !== undefined && record.reason !== filter.reason) continue;
    if (filter.since !== undefined && record.published_at < filter.since) continue;
    if (filter.until !== undefined && record.published_at >= filter.until) continue;
    matches.push(record);
  }
  matches.sort((a, b) => b.published_at.getTime() - a.published_at.getTime());
  return matches.slice(0, clampListLimit(filter.limit));
}

// Kysely query-builder generics make a narrow query type prohibitively
// verbose; the function only chains `.where(...)` calls that return the
// same builder, so the runtime contract is honored.
// biome-ignore lint/suspicious/noExplicitAny: see comment above
function applyFilter<Q extends { where: (...args: any[]) => Q }>(
  query: Q,
  filter: ListDlqRecordsFilter,
): Q {
  let q = query;
  const includeResolved = filter.includeResolved ?? false;
  if (!includeResolved) {
    q = q.where("resolved_at", "is", null);
  }
  if (filter.errorClass !== undefined) {
    q = q.where("error_class", "=", filter.errorClass);
  }
  if (filter.reason !== undefined) {
    q = q.where("reason", "=", filter.reason);
  }
  if (filter.since !== undefined) {
    q = q.where("published_at", ">=", filter.since);
  }
  if (filter.until !== undefined) {
    q = q.where("published_at", "<", filter.until);
  }
  return q;
}

interface DlqRecordRow {
  dlq_id: string;
  destination_id: string;
  event_id: string;
  event_name: string;
  project_id: string;
  environment: string;
  vendor: string;
  consumer_version: string;
  normalize_version: string;
  mapper_version: string;
  deliverer_version: string;
  attempts: number;
  reason: string;
  error_class: string | null;
  vendor_response_code: string | null;
  vendor_response_summary: string | null;
  delivery_key: string | null;
  source_topic: string;
  source_partition: number;
  source_offset: string;
  headers: unknown;
  payload: Buffer | null;
  published_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

function toRecord(row: DlqRecordRow): DlqRecord {
  return {
    dlq_id: row.dlq_id,
    destination_id: row.destination_id,
    event_id: row.event_id,
    event_name: row.event_name,
    project_id: row.project_id,
    environment: row.environment,
    vendor: row.vendor,
    consumer_version: row.consumer_version,
    normalize_version: row.normalize_version,
    mapper_version: row.mapper_version,
    deliverer_version: row.deliverer_version,
    attempts: row.attempts,
    reason: row.reason,
    error_class: parseErrorClass(row.error_class),
    vendor_response_code: row.vendor_response_code,
    vendor_response_summary: row.vendor_response_summary,
    delivery_key: row.delivery_key,
    source_topic: row.source_topic,
    source_partition: row.source_partition,
    source_offset: row.source_offset,
    headers: parseHeaders(row.headers),
    payload: row.payload,
    published_at: row.published_at,
    resolved_at: row.resolved_at,
    resolved_by: row.resolved_by,
    resolution_note: row.resolution_note,
  };
}

function parseErrorClass(value: string | null): DeliveryRecordErrorClass | null {
  if (value === null) return null;
  if (isDeliveryRecordErrorClass(value)) return value;
  return null;
}

function parseHeaders(value: unknown): Readonly<Record<string, string>> {
  if (value === null || value === undefined) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return normalizeHeaderMap(parsed);
    } catch {
      return {};
    }
  }
  return normalizeHeaderMap(value);
}

function normalizeHeaderMap(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
    else if (v !== null && v !== undefined) out[k] = String(v);
  }
  return out;
}
