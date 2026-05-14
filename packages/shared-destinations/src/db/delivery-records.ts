/**
 * Typed Kysely view of the `delivery_records` table plus repository helpers.
 *
 * The table is created by
 * `db/migrations/20260512000010_create_delivery_records.sql`. This module:
 *
 *   1. Mirrors the SQL schema as a `DeliveryRecordsTable` interface.
 *   2. Extends `@polaris/shared-db`'s `Database` interface via module
 *      augmentation so any `Kysely<Database>` instance in the runtime gets
 *      `db.selectFrom("delivery_records")` typed automatically (same pattern
 *      P6-006 used for `audit_records` and P8-001 used for `processor_runs`).
 *   3. Owns the typed `DeliveryRecordStatus` / `DeliveryRecordErrorClass`
 *      unions the runtime branches on, with closed-set arrays so exhaustive
 *      switches catch missed variants.
 *   4. Exposes a small `DeliveryRecordRepository` contract with an in-memory
 *      adapter (tests / bootstrap) and a Kysely-backed adapter (production).
 *
 * Hard rules baked into this module:
 *
 *   - The schema has no column resembling a resolved secret value or a full
 *     vendor response body. The TypeScript surface mirrors that: there is no
 *     way to type-correctly insert a `secret`, `token`, `bearer`, or
 *     `vendor_response_body` field. Tests in
 *     `test/no-secret-shape.test.ts` assert this at the surface level.
 *
 *   - `vendor_response_summary` is capped at 1 KB at the application layer.
 *     The repository truncates on insert; the migration enforces the same
 *     cap with a CHECK constraint.
 *
 *   - `delivery_id` is UUIDv7. The repository allocates one when the caller
 *     omits it (`uuidv7()`).
 *
 * @see db/migrations/20260512000010_create_delivery_records.sql
 * @see packages/shared-destinations/src/runtime.ts
 */

import type { Database } from "@polaris/shared-db";
import type { ColumnType, Kysely } from "kysely";
import { v7 as uuidv7 } from "uuid";

// ---------------------------------------------------------------------------
// Closed-set status / error_class unions
// ---------------------------------------------------------------------------

/**
 * Closed set of delivery outcome statuses. Mirrors the
 * `delivery_records_status_allowed` CHECK constraint in the migration.
 *
 * The runtime selects a status per outcome:
 *
 *   - `accepted`             vendor returned a 2xx-equivalent signal.
 *   - `delivered`            reserved for vendor-protocol "delivered"
 *                            signals distinct from "accepted". v1 emits
 *                            `accepted` only; `delivered` lands once a
 *                            vendor that distinguishes the two surfaces.
 *   - `dropped_consent`      consent gating dropped the event.
 *   - `dropped_no_identity`  no usable identity field after normalize.
 *   - `dropped_invalid`      defensive second-pass redaction rejected the
 *                            event, or the envelope was malformed.
 *   - `mapped_failed`        the vendor mapper threw.
 *   - `failed_retryable`     transient failure; the runtime republishes
 *                            to `<vendor>.retry`.
 *   - `failed_permanent`     vendor returned a permanent failure; the
 *                            runtime republishes to `<vendor>.dlq`.
 */
export const DELIVERY_RECORD_STATUSES = [
  "accepted",
  "delivered",
  "dropped_consent",
  "dropped_no_identity",
  "dropped_invalid",
  "mapped_failed",
  "failed_retryable",
  "failed_permanent",
] as const;
export type DeliveryRecordStatus = (typeof DELIVERY_RECORD_STATUSES)[number];

/** Type-narrowing guard for delivery record statuses. */
export function isDeliveryRecordStatus(value: string): value is DeliveryRecordStatus {
  return (DELIVERY_RECORD_STATUSES as readonly string[]).includes(value);
}

/**
 * Closed set of error_class labels. Mirrors the
 * `delivery_records_error_class_allowed` CHECK constraint in the migration.
 *
 *   - `consent`     consent gating drop.
 *   - `identity`    no usable identity drop.
 *   - `mapping`     mapper threw.
 *   - `auth`        vendor auth failure (token expired / revoked).
 *   - `rate_limit`  vendor rate-limit response (HTTP 429 etc.).
 *   - `transient`   transient broker / network failure.
 *   - `permanent`   vendor reported permanent failure (4xx contract).
 *   - `timeout`     delivery timed out.
 *   - `policy`      defensive second-pass redaction rejected the event.
 */
export const DELIVERY_RECORD_ERROR_CLASSES = [
  "consent",
  "identity",
  "mapping",
  "auth",
  "rate_limit",
  "transient",
  "permanent",
  "timeout",
  "policy",
] as const;
export type DeliveryRecordErrorClass = (typeof DELIVERY_RECORD_ERROR_CLASSES)[number];

/** Type-narrowing guard for delivery record error classes. */
export function isDeliveryRecordErrorClass(value: string): value is DeliveryRecordErrorClass {
  return (DELIVERY_RECORD_ERROR_CLASSES as readonly string[]).includes(value);
}

/**
 * Application-layer cap on `vendor_response_summary` length. Matches the
 * migration's `delivery_records_vendor_response_summary_length` CHECK
 * constraint (1024 chars). The repository truncates inputs before insert.
 */
export const VENDOR_RESPONSE_SUMMARY_MAX_LENGTH = 1024;

// ---------------------------------------------------------------------------
// Typed table mirror
// ---------------------------------------------------------------------------

/**
 * Typed mirror of the `delivery_records` table.
 *
 * Extends `@polaris/shared-db`'s `Database` interface via module augmentation
 * (the `declare module` below) so any `Kysely<Database>` instance in the
 * runtime gets `db.selectFrom("delivery_records")` typed automatically.
 */
export interface DeliveryRecordsTable {
  delivery_id: string;
  destination_id: string;
  event_id: string;
  event_name: string;
  project_id: string;
  environment: string;
  consumer_version: string;
  normalize_version: string;
  mapper_version: string;
  deliverer_version: string;
  attempt: ColumnType<number, number | undefined, number>;
  status: ColumnType<DeliveryRecordStatus, DeliveryRecordStatus, DeliveryRecordStatus>;
  error_class: ColumnType<
    DeliveryRecordErrorClass | null,
    DeliveryRecordErrorClass | null | undefined,
    DeliveryRecordErrorClass | null
  >;
  vendor_response_code: ColumnType<string | null, string | null | undefined, string | null>;
  vendor_response_summary: ColumnType<string | null, string | null | undefined, string | null>;
  dedupe_key: ColumnType<string | null, string | null | undefined, string | null>;
  started_at: ColumnType<Date, Date | string | undefined, Date | string>;
  finished_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

declare module "@polaris/shared-db" {
  interface Database {
    delivery_records: DeliveryRecordsTable;
  }
}

// ---------------------------------------------------------------------------
// Application-layer record + insert input
// ---------------------------------------------------------------------------

/**
 * Read-shape returned by `DeliveryRecordRepository.findRecord` and
 * `recordDelivery`. Plain JS types: timestamps as Date, status / error_class
 * narrowed to the closed-set unions.
 */
export interface DeliveryRecord {
  readonly delivery_id: string;
  readonly destination_id: string;
  readonly event_id: string;
  readonly event_name: string;
  readonly project_id: string;
  readonly environment: string;
  readonly consumer_version: string;
  readonly normalize_version: string;
  readonly mapper_version: string;
  readonly deliverer_version: string;
  readonly attempt: number;
  readonly status: DeliveryRecordStatus;
  readonly error_class: DeliveryRecordErrorClass | null;
  readonly vendor_response_code: string | null;
  readonly vendor_response_summary: string | null;
  readonly dedupe_key: string | null;
  readonly started_at: Date;
  readonly finished_at: Date;
}

/**
 * Input accepted by `recordDelivery`. Most fields mirror `DeliveryRecord`;
 * `delivery_id` is optional (the repository allocates a UUIDv7 when omitted)
 * and `started_at` / `finished_at` default to `now()`.
 *
 * The shape intentionally has NO `secret`, `token`, `bearer`, `credential`,
 * `vendor_response_body`, or similar field — those are forbidden by
 * architecture. Tests in `test/no-secret-shape.test.ts` lock this surface.
 */
export interface RecordDeliveryInput {
  readonly delivery_id?: string;
  readonly destination_id: string;
  readonly event_id: string;
  readonly event_name: string;
  readonly project_id: string;
  readonly environment: string;
  readonly consumer_version: string;
  readonly normalize_version: string;
  readonly mapper_version: string;
  readonly deliverer_version: string;
  readonly attempt: number;
  readonly status: DeliveryRecordStatus;
  readonly error_class?: DeliveryRecordErrorClass | null;
  readonly vendor_response_code?: string | null;
  readonly vendor_response_summary?: string | null;
  readonly dedupe_key?: string | null;
  readonly started_at?: Date;
  readonly finished_at?: Date;
}

/**
 * Filters accepted by `findByDestinationId`. Each is optional; the
 * repository applies the ones that are set and ignores the rest.
 *
 *   - `status`        narrow to one outcome (e.g. only `failed_permanent`)
 *   - `errorClass`    narrow to one error_class label
 *   - `since` / `until`
 *                     half-open finished-at window (`finished_at >= since`,
 *                     `finished_at < until`); both default to "no bound"
 *   - `limit`         max rows returned; the repository caps at 1000 to
 *                     stop a runaway CLI invocation from blowing memory
 */
export interface ListDeliveryRecordsFilter {
  readonly status?: DeliveryRecordStatus;
  readonly errorClass?: DeliveryRecordErrorClass;
  readonly since?: Date;
  readonly until?: Date;
  readonly limit?: number;
}

/** Maximum number of rows `findByDestinationId` will ever return. */
export const LIST_DELIVERY_RECORDS_HARD_LIMIT = 1000 as const;

/** Repository contract. Implementations: in-memory + Kysely. */
export interface DeliveryRecordRepository {
  /** Insert one record. Returns the persisted row. */
  recordDelivery(input: RecordDeliveryInput): Promise<DeliveryRecord>;
  /** Read one record by id. Returns `null` when not found. */
  findRecord(delivery_id: string): Promise<DeliveryRecord | null>;
  /**
   * List delivery records for an event_id, ordered by `finished_at DESC`.
   * Used by the future `polaris destinations records list --event-id ...`
   * command and by the runtime's idempotent-replay guard.
   */
  findRecordsByEventId(event_id: string): Promise<readonly DeliveryRecord[]>;
  /**
   * List delivery records for a destination_id, ordered by
   * `finished_at DESC`. Filter knobs narrow by status, error class, and
   * time window. Capped at `LIST_DELIVERY_RECORDS_HARD_LIMIT` rows.
   *
   * Used by `polaris deliveries list <destination_id>` (P9-007).
   */
  findByDestinationId(
    destination_id: string,
    filter?: ListDeliveryRecordsFilter,
  ): Promise<readonly DeliveryRecord[]>;
}

// ---------------------------------------------------------------------------
// In-memory adapter
// ---------------------------------------------------------------------------

/** Options accepted by the in-memory adapter. `now` makes tests deterministic. */
export interface InMemoryDeliveryRecordRepositoryOptions {
  readonly now?: () => Date;
}

/**
 * Pure in-memory `DeliveryRecordRepository`. Suitable for unit tests and the
 * smoke harness.
 */
export class InMemoryDeliveryRecordRepository implements DeliveryRecordRepository {
  private readonly records = new Map<string, DeliveryRecord>();
  private readonly now: () => Date;

  constructor(options: InMemoryDeliveryRecordRepositoryOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async recordDelivery(input: RecordDeliveryInput): Promise<DeliveryRecord> {
    const delivery_id = input.delivery_id ?? uuidv7();
    const startedAt = input.started_at ?? this.now();
    const finishedAt = input.finished_at ?? this.now();
    const record: DeliveryRecord = {
      delivery_id,
      destination_id: input.destination_id,
      event_id: input.event_id,
      event_name: input.event_name,
      project_id: input.project_id,
      environment: input.environment,
      consumer_version: input.consumer_version,
      normalize_version: input.normalize_version,
      mapper_version: input.mapper_version,
      deliverer_version: input.deliverer_version,
      attempt: input.attempt,
      status: input.status,
      error_class: input.error_class ?? null,
      vendor_response_code: input.vendor_response_code ?? null,
      vendor_response_summary: truncateSummary(input.vendor_response_summary),
      dedupe_key: input.dedupe_key ?? null,
      started_at: startedAt,
      finished_at: finishedAt,
    };
    this.records.set(delivery_id, record);
    return record;
  }

  async findRecord(delivery_id: string): Promise<DeliveryRecord | null> {
    return this.records.get(delivery_id) ?? null;
  }

  async findRecordsByEventId(event_id: string): Promise<readonly DeliveryRecord[]> {
    const matches: DeliveryRecord[] = [];
    for (const record of this.records.values()) {
      if (record.event_id === event_id) matches.push(record);
    }
    return matches.sort((a, b) => b.finished_at.getTime() - a.finished_at.getTime());
  }

  async findByDestinationId(
    destination_id: string,
    filter: ListDeliveryRecordsFilter = {},
  ): Promise<readonly DeliveryRecord[]> {
    const matches: DeliveryRecord[] = [];
    for (const record of this.records.values()) {
      if (record.destination_id !== destination_id) continue;
      if (filter.status !== undefined && record.status !== filter.status) continue;
      if (filter.errorClass !== undefined && record.error_class !== filter.errorClass) continue;
      if (filter.since !== undefined && record.finished_at < filter.since) continue;
      if (filter.until !== undefined && record.finished_at >= filter.until) continue;
      matches.push(record);
    }
    matches.sort((a, b) => b.finished_at.getTime() - a.finished_at.getTime());
    const limit = clampListLimit(filter.limit);
    return matches.slice(0, limit);
  }

  /** Snapshot every record. Useful for tests. */
  snapshot(): readonly DeliveryRecord[] {
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

/**
 * Options accepted by the SQL-backed adapter. `now` makes timestamps
 * deterministic in integration tests; production passes the default and
 * PostgreSQL's `now()` defaults apply on inserted rows.
 */
export interface KyselyDeliveryRecordRepositoryOptions {
  readonly db: Kysely<Database>;
  readonly now?: () => Date;
}

/**
 * Build a Kysely-backed `DeliveryRecordRepository`. Implements the same
 * contract as the in-memory adapter.
 */
export function createKyselyDeliveryRecordRepository(
  options: KyselyDeliveryRecordRepositoryOptions,
): DeliveryRecordRepository {
  const { db } = options;
  const now = options.now ?? (() => new Date());

  async function recordDelivery(input: RecordDeliveryInput): Promise<DeliveryRecord> {
    const delivery_id = input.delivery_id ?? uuidv7();
    const startedAt = input.started_at ?? now();
    const finishedAt = input.finished_at ?? now();
    const inserted = await db
      .insertInto("delivery_records")
      .values({
        delivery_id,
        destination_id: input.destination_id,
        event_id: input.event_id,
        event_name: input.event_name,
        project_id: input.project_id,
        environment: input.environment,
        consumer_version: input.consumer_version,
        normalize_version: input.normalize_version,
        mapper_version: input.mapper_version,
        deliverer_version: input.deliverer_version,
        attempt: input.attempt,
        status: input.status,
        error_class: input.error_class ?? null,
        vendor_response_code: input.vendor_response_code ?? null,
        vendor_response_summary: truncateSummary(input.vendor_response_summary),
        dedupe_key: input.dedupe_key ?? null,
        started_at: startedAt,
        finished_at: finishedAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRecord(inserted);
  }

  async function findRecord(delivery_id: string): Promise<DeliveryRecord | null> {
    const row = await db
      .selectFrom("delivery_records")
      .selectAll()
      .where("delivery_id", "=", delivery_id)
      .executeTakeFirst();
    return row === undefined ? null : toRecord(row);
  }

  async function findRecordsByEventId(event_id: string): Promise<readonly DeliveryRecord[]> {
    const rows = await db
      .selectFrom("delivery_records")
      .selectAll()
      .where("event_id", "=", event_id)
      .orderBy("finished_at", "desc")
      .execute();
    return rows.map(toRecord);
  }

  async function findByDestinationId(
    destination_id: string,
    filter: ListDeliveryRecordsFilter = {},
  ): Promise<readonly DeliveryRecord[]> {
    let query = db
      .selectFrom("delivery_records")
      .selectAll()
      .where("destination_id", "=", destination_id);
    if (filter.status !== undefined) {
      query = query.where("status", "=", filter.status);
    }
    if (filter.errorClass !== undefined) {
      query = query.where("error_class", "=", filter.errorClass);
    }
    if (filter.since !== undefined) {
      query = query.where("finished_at", ">=", filter.since);
    }
    if (filter.until !== undefined) {
      query = query.where("finished_at", "<", filter.until);
    }
    const limit = clampListLimit(filter.limit);
    const rows = await query.orderBy("finished_at", "desc").limit(limit).execute();
    return rows.map(toRecord);
  }

  return { recordDelivery, findRecord, findRecordsByEventId, findByDestinationId };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Clamp a caller-supplied `limit` to `[1, LIST_DELIVERY_RECORDS_HARD_LIMIT]`.
 * Undefined / zero / negative values fall back to the hard cap so the CLI's
 * default `polaris deliveries list` invocation returns the maximum allowed
 * rows without the caller having to think about it.
 */
function clampListLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return LIST_DELIVERY_RECORDS_HARD_LIMIT;
  }
  return Math.min(Math.floor(value), LIST_DELIVERY_RECORDS_HARD_LIMIT);
}

/** Truncate `vendor_response_summary` to the CHECK-constrained max length. */
export function truncateSummary(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (value.length <= VENDOR_RESPONSE_SUMMARY_MAX_LENGTH) return value;
  return `${value.slice(0, VENDOR_RESPONSE_SUMMARY_MAX_LENGTH - 1)}…`;
}

interface DeliveryRecordRow {
  delivery_id: string;
  destination_id: string;
  event_id: string;
  event_name: string;
  project_id: string;
  environment: string;
  consumer_version: string;
  normalize_version: string;
  mapper_version: string;
  deliverer_version: string;
  attempt: number;
  status: string;
  error_class: string | null;
  vendor_response_code: string | null;
  vendor_response_summary: string | null;
  dedupe_key: string | null;
  started_at: Date;
  finished_at: Date;
}

function toRecord(row: DeliveryRecordRow): DeliveryRecord {
  return {
    delivery_id: row.delivery_id,
    destination_id: row.destination_id,
    event_id: row.event_id,
    event_name: row.event_name,
    project_id: row.project_id,
    environment: row.environment,
    consumer_version: row.consumer_version,
    normalize_version: row.normalize_version,
    mapper_version: row.mapper_version,
    deliverer_version: row.deliverer_version,
    attempt: row.attempt,
    status: asStatus(row.status),
    error_class: row.error_class === null ? null : asErrorClass(row.error_class),
    vendor_response_code: row.vendor_response_code,
    vendor_response_summary: row.vendor_response_summary,
    dedupe_key: row.dedupe_key,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}

function asStatus(value: string): DeliveryRecordStatus {
  if (isDeliveryRecordStatus(value)) return value;
  // The CHECK constraint rejects anything else; the cast remains so a
  // corrupted row produces a typed value rather than throwing at the call
  // site.
  return "failed_permanent";
}

function asErrorClass(value: string): DeliveryRecordErrorClass | null {
  if (isDeliveryRecordErrorClass(value)) return value;
  return "permanent";
}
