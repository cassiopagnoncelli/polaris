/**
 * Typed Kysely view of the `processor_dlq_records` table plus
 * repository helpers (3L2HKMND).
 *
 * Counterpart to `@polaris/shared-destinations`'s `dlq_records`
 * surface, scaled down to the processor side:
 *
 *   - Identity tuple is `(processor_name, processor_version)`
 *     rather than the destination
 *     vendor/consumer/normalize/mapper/deliverer.
 *   - `error_class` and `error_message` are free-form text rather
 *     than the destination's closed-set enum (the processor
 *     classifier emits `decode_failed` / `unknown_error` /
 *     `validation_failed` / ...).
 *
 * Mirrors the destination repo shape so the CLI surface and the
 * triage runbook read consistently across both DLQ surfaces.
 *
 * @see db/postgres/migrations/20260516000001_create_processor_dlq_records.sql
 * @see libs/delivery/destinations/src/db/dlq-records.ts
 */

import type { Database } from "@polaris/shared-db";
import type { ColumnType, Kysely } from "kysely";
import { v7 as uuidv7 } from "uuid";

/** Prefix for repository-allocated DLQ ids. */
export const PROCESSOR_DLQ_RECORD_ID_PREFIX = "polaris_pdlq_";

/** Maximum rows returned by a single `findBy...` query. */
export const LIST_PROCESSOR_DLQ_RECORDS_HARD_LIMIT = 1000 as const;

/**
 * Typed mirror of the `processor_dlq_records` table.
 *
 * Extends `@polaris/shared-db`'s `Database` interface via module
 * augmentation so any `Kysely<Database>` instance in the runtime
 * gets `db.selectFrom("processor_dlq_records")` typed automatically.
 */
export interface ProcessorDlqRecordsTable {
  dlq_id: string;
  processor_name: string;
  processor_version: string;
  event_id: string;
  event_name: string;
  project_id: string;
  environment: string;
  attempts: ColumnType<number, number | undefined, number>;
  reason: string;
  error_class: ColumnType<string | null, string | null | undefined, string | null>;
  error_message: ColumnType<string | null, string | null | undefined, string | null>;
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

declare module "@polaris/shared-db" {
  interface Database {
    processor_dlq_records: ProcessorDlqRecordsTable;
  }
}

// ---------------------------------------------------------------------------
// Application-layer record + insert input
// ---------------------------------------------------------------------------

export interface ProcessorDlqRecord {
  readonly dlq_id: string;
  readonly processor_name: string;
  readonly processor_version: string;
  readonly event_id: string;
  readonly event_name: string;
  readonly project_id: string;
  readonly environment: string;
  readonly attempts: number;
  readonly reason: string;
  readonly error_class: string | null;
  readonly error_message: string | null;
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

export interface RecordProcessorDlqInput {
  readonly dlq_id?: string;
  readonly processor_name: string;
  readonly processor_version: string;
  readonly event_id: string;
  readonly event_name: string;
  readonly project_id: string;
  readonly environment: string;
  readonly attempts: number;
  readonly reason: string;
  readonly error_class?: string | null;
  readonly error_message?: string | null;
  readonly source_topic: string;
  readonly source_partition: number;
  readonly source_offset: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly payload?: Buffer | null;
  readonly published_at?: Date;
}

export interface MarkResolvedOutcome {
  readonly applied: boolean;
  readonly record: ProcessorDlqRecord;
}

export interface ListProcessorDlqRecordsFilter {
  readonly reason?: string;
  readonly since?: Date;
  readonly until?: Date;
  readonly includeResolved?: boolean;
  readonly limit?: number;
}

export interface ProcessorDlqRecordRepository {
  recordDlq(input: RecordProcessorDlqInput): Promise<ProcessorDlqRecord>;
  findRecord(dlq_id: string): Promise<ProcessorDlqRecord | null>;
  findByProcessor(
    processor_name: string,
    filter?: ListProcessorDlqRecordsFilter,
  ): Promise<readonly ProcessorDlqRecord[]>;
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

export interface InMemoryProcessorDlqRecordRepositoryOptions {
  readonly now?: () => Date;
}

export class InMemoryProcessorDlqRecordRepository implements ProcessorDlqRecordRepository {
  private readonly records = new Map<string, ProcessorDlqRecord>();
  private readonly now: () => Date;

  constructor(options: InMemoryProcessorDlqRecordRepositoryOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async recordDlq(input: RecordProcessorDlqInput): Promise<ProcessorDlqRecord> {
    const dlq_id = input.dlq_id ?? `${PROCESSOR_DLQ_RECORD_ID_PREFIX}${uuidv7()}`;
    const record: ProcessorDlqRecord = {
      dlq_id,
      processor_name: input.processor_name,
      processor_version: input.processor_version,
      event_id: input.event_id,
      event_name: input.event_name,
      project_id: input.project_id,
      environment: input.environment,
      attempts: input.attempts,
      reason: input.reason,
      error_class: input.error_class ?? null,
      error_message: truncateErrorMessage(input.error_message),
      source_topic: input.source_topic,
      source_partition: input.source_partition,
      source_offset: input.source_offset,
      headers: Object.freeze({ ...(input.headers ?? {}) }),
      payload: input.payload ?? null,
      published_at: input.published_at ?? this.now(),
      resolved_at: null,
      resolved_by: null,
      resolution_note: null,
    };
    this.records.set(dlq_id, record);
    return record;
  }

  async findRecord(dlq_id: string): Promise<ProcessorDlqRecord | null> {
    return this.records.get(dlq_id) ?? null;
  }

  async findByProcessor(
    processor_name: string,
    filter: ListProcessorDlqRecordsFilter = {},
  ): Promise<readonly ProcessorDlqRecord[]> {
    const matches: ProcessorDlqRecord[] = [];
    const includeResolved = filter.includeResolved ?? false;
    for (const record of this.records.values()) {
      if (record.processor_name !== processor_name) continue;
      if (!includeResolved && record.resolved_at !== null) continue;
      if (filter.reason !== undefined && record.reason !== filter.reason) continue;
      if (filter.since !== undefined && record.published_at < filter.since) continue;
      if (filter.until !== undefined && record.published_at >= filter.until) continue;
      matches.push(record);
    }
    matches.sort((a, b) => b.published_at.getTime() - a.published_at.getTime());
    return matches.slice(0, clampListLimit(filter.limit));
  }

  async markResolved(
    dlq_id: string,
    resolvedBy: string,
    note: string | null,
    resolvedAt?: Date,
  ): Promise<MarkResolvedOutcome> {
    const existing = this.records.get(dlq_id);
    if (existing === undefined) {
      throw new Error(`processor_dlq_records: unknown dlq_id ${dlq_id}`);
    }
    if (existing.resolved_at !== null) {
      return { applied: false, record: existing };
    }
    const next: ProcessorDlqRecord = {
      ...existing,
      resolved_at: resolvedAt ?? this.now(),
      resolved_by: resolvedBy,
      resolution_note: note,
    };
    this.records.set(dlq_id, next);
    return { applied: true, record: next };
  }

  /** Snapshot every record. Useful for tests. */
  snapshot(): readonly ProcessorDlqRecord[] {
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

export interface KyselyProcessorDlqRecordRepositoryOptions {
  readonly db: Kysely<Database>;
  readonly now?: () => Date;
}

export function createKyselyProcessorDlqRecordRepository(
  options: KyselyProcessorDlqRecordRepositoryOptions,
): ProcessorDlqRecordRepository {
  const { db } = options;
  const now = options.now ?? (() => new Date());

  async function recordDlq(input: RecordProcessorDlqInput): Promise<ProcessorDlqRecord> {
    const dlq_id = input.dlq_id ?? `${PROCESSOR_DLQ_RECORD_ID_PREFIX}${uuidv7()}`;
    const published_at = input.published_at ?? now();
    const inserted = await db
      .insertInto("processor_dlq_records")
      .values({
        dlq_id,
        processor_name: input.processor_name,
        processor_version: input.processor_version,
        event_id: input.event_id,
        event_name: input.event_name,
        project_id: input.project_id,
        environment: input.environment,
        attempts: input.attempts,
        reason: input.reason,
        error_class: input.error_class ?? null,
        error_message: truncateErrorMessage(input.error_message),
        source_topic: input.source_topic,
        source_partition: input.source_partition,
        source_offset: input.source_offset,
        headers: JSON.stringify({ ...(input.headers ?? {}) }),
        payload: input.payload ?? null,
        published_at,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRecord(inserted);
  }

  async function findRecord(dlq_id: string): Promise<ProcessorDlqRecord | null> {
    const row = await db
      .selectFrom("processor_dlq_records")
      .selectAll()
      .where("dlq_id", "=", dlq_id)
      .executeTakeFirst();
    return row === undefined ? null : toRecord(row);
  }

  async function findByProcessor(
    processor_name: string,
    filter: ListProcessorDlqRecordsFilter = {},
  ): Promise<readonly ProcessorDlqRecord[]> {
    let query = db
      .selectFrom("processor_dlq_records")
      .selectAll()
      .where("processor_name", "=", processor_name);
    const includeResolved = filter.includeResolved ?? false;
    if (!includeResolved) {
      query = query.where("resolved_at", "is", null);
    }
    if (filter.reason !== undefined) {
      query = query.where("reason", "=", filter.reason);
    }
    if (filter.since !== undefined) {
      query = query.where("published_at", ">=", filter.since);
    }
    if (filter.until !== undefined) {
      query = query.where("published_at", "<", filter.until);
    }
    const limit = clampListLimit(filter.limit);
    const rows = await query.orderBy("published_at", "desc").limit(limit).execute();
    return rows.map(toRecord);
  }

  async function markResolved(
    dlq_id: string,
    resolvedBy: string,
    note: string | null,
    resolvedAt?: Date,
  ): Promise<MarkResolvedOutcome> {
    const existing = await findRecord(dlq_id);
    if (existing === null) {
      throw new Error(`processor_dlq_records: unknown dlq_id ${dlq_id}`);
    }
    if (existing.resolved_at !== null) {
      return { applied: false, record: existing };
    }
    const next = resolvedAt ?? now();
    const updated = await db
      .updateTable("processor_dlq_records")
      .set({
        resolved_at: next,
        resolved_by: resolvedBy,
        resolution_note: note,
      })
      .where("dlq_id", "=", dlq_id)
      .where("resolved_at", "is", null)
      .returningAll()
      .executeTakeFirst();
    if (updated === undefined) {
      // Race: another writer resolved between our find + update.
      const fresh = await findRecord(dlq_id);
      if (fresh === null) {
        throw new Error(`processor_dlq_records: unknown dlq_id ${dlq_id}`);
      }
      return { applied: false, record: fresh };
    }
    return { applied: true, record: toRecord(updated) };
  }

  return { recordDlq, findRecord, findByProcessor, markResolved };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ProcessorDlqRecordRow {
  dlq_id: string;
  processor_name: string;
  processor_version: string;
  event_id: string;
  event_name: string;
  project_id: string;
  environment: string;
  attempts: number;
  reason: string;
  error_class: string | null;
  error_message: string | null;
  source_topic: string;
  source_partition: number;
  source_offset: string;
  headers: Record<string, string> | string;
  payload: Buffer | null;
  published_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

function toRecord(row: ProcessorDlqRecordRow): ProcessorDlqRecord {
  const headers =
    typeof row.headers === "string"
      ? (JSON.parse(row.headers) as Record<string, string>)
      : row.headers;
  return {
    dlq_id: row.dlq_id,
    processor_name: row.processor_name,
    processor_version: row.processor_version,
    event_id: row.event_id,
    event_name: row.event_name,
    project_id: row.project_id,
    environment: row.environment,
    attempts: row.attempts,
    reason: row.reason,
    error_class: row.error_class,
    error_message: row.error_message,
    source_topic: row.source_topic,
    source_partition: row.source_partition,
    source_offset: row.source_offset,
    headers: Object.freeze({ ...headers }),
    payload: row.payload,
    published_at: row.published_at,
    resolved_at: row.resolved_at,
    resolved_by: row.resolved_by,
    resolution_note: row.resolution_note,
  };
}

function clampListLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return LIST_PROCESSOR_DLQ_RECORDS_HARD_LIMIT;
  }
  return Math.min(Math.floor(value), LIST_PROCESSOR_DLQ_RECORDS_HARD_LIMIT);
}

/** Match the migration's 4096-char CHECK on `error_message`. */
const ERROR_MESSAGE_MAX_LENGTH = 4096 as const;

function truncateErrorMessage(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (value.length <= ERROR_MESSAGE_MAX_LENGTH) return value;
  return `${value.slice(0, ERROR_MESSAGE_MAX_LENGTH - 1)}…`;
}
