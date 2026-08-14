/**
 * Repository contract for `identity_links` rows.
 *
 * The resolver writes durable identity links to PostgreSQL. The repository
 * is the seam between the runtime and the database: the runtime decides
 * **what** to record (authoritative-overlap rule) and the repository owns
 * **how** to persist it.
 *
 * Two implementations satisfy the contract:
 *
 *   - `InMemoryIdentityLinkRepository` — used by tests and the smoke
 *     harness. Same lookup / insert / supersede semantics as the SQL
 *     adapter so the runtime unit tests cover the same flow that
 *     production runs.
 *
 *   - `createKyselyIdentityLinkRepository` — production binding against
 *     `@polaris/shared-db`'s typed `Kysely<Database>`. The implementation
 *     lives at the bottom of this file.
 *
 * The contract is intentionally narrow. The resolver never deletes rows —
 * superseded links carry `superseded_at` so the audit trail stays intact.
 * Heuristic promotion (candidate → authoritative) will be a row UPDATE
 * landed by a later processor; this v1 repo never emits `candidate` so
 * the `confidence` slot on insert is always `authoritative`.
 *
 * @see db/migrations/20260512000010_create_identity_links.sql
 */

import type { Database, IdentityLinkConfidence } from "@polaris/shared-db";
import type { Kysely } from "kysely";
import { v7 as uuidv7 } from "uuid";

/**
 * Persisted row shape returned by the repository. The fields mirror the
 * `identity_links` table (see migration). `confidence` is narrowed to the
 * closed enum so callers can branch on it without re-casting.
 */
export interface IdentityLinkRecord {
  readonly link_id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly left_identifier: string;
  readonly right_identifier: string;
  readonly confidence: IdentityLinkConfidence;
  readonly evidence_type: string;
  readonly evidence: Record<string, unknown>;
  readonly reason: string;
  readonly processor_name: string;
  readonly processor_version: string;
  readonly run_id: string | null;
  readonly created_at: Date;
  readonly superseded_at: Date | null;
}

/**
 * Input accepted by `findActiveByLeft` / `findActiveByRight`. Scope is
 * always (project, environment) because the canonical graph is
 * project-bounded in v1.
 */
export interface FindActiveInput {
  readonly project_id: string;
  readonly environment: string;
  readonly identifier: string;
  /**
   * Optional `evidence_type` filter. When supplied, the lookup returns
   * only links whose `evidence_type` matches — useful for "is there an
   * active explicit_overlap link for this anonymous_id?" probes. When
   * absent, every active link is returned.
   */
  readonly evidence_type?: string | undefined;
}

/** Input accepted by `insertLink`. */
export interface InsertLinkInput {
  readonly link_id?: string | undefined;
  readonly project_id: string;
  readonly environment: string;
  readonly left_identifier: string;
  readonly right_identifier: string;
  readonly confidence: IdentityLinkConfidence;
  readonly evidence_type: string;
  readonly evidence: Record<string, unknown>;
  readonly reason: string;
  readonly processor_name: string;
  readonly processor_version: string;
  readonly run_id?: string | null | undefined;
  /** Explicit `created_at`. Defaults to `now()` per the repository's clock. */
  readonly created_at?: Date | undefined;
}

/** Input accepted by `supersedeLink`. */
export interface SupersedeLinkInput {
  readonly link_id: string;
  /** When the row was retired. Defaults to `now()` per the repository's clock. */
  readonly superseded_at?: Date | undefined;
}

/**
 * Repository contract. Implementations:
 *
 *   - `InMemoryIdentityLinkRepository`
 *   - `createKyselyIdentityLinkRepository`
 *
 * The contract returns the persisted row from every mutating call so the
 * runtime can immediately emit the corresponding `identity.linked` /
 * `identity.merged` event with the row's `link_id` and `created_at` known.
 */
export interface IdentityLinkRepository {
  /**
   * Look up every ACTIVE link where the given identifier appears in either
   * the left or right slot. Used to answer "is this identifier already
   * bound to something authoritative?".
   */
  findActive(input: FindActiveInput): Promise<ReadonlyArray<IdentityLinkRecord>>;
  /**
   * Insert a new link row. Returns the persisted record (with platform-
   * generated `link_id` and `created_at` populated). When the unique
   * constraint on the active `(left, right, evidence_type)` triple
   * already holds a row, callers MUST detect that via `findActive`
   * BEFORE calling insert; this method does not perform UPSERT.
   */
  insertLink(input: InsertLinkInput): Promise<IdentityLinkRecord>;
  /**
   * Mark an active row as superseded. Sets `superseded_at`. The row is
   * NEVER deleted — audit trail is preserved.
   */
  supersedeLink(input: SupersedeLinkInput): Promise<IdentityLinkRecord>;
  /** Convenience: fetch a row by `link_id`. */
  findById(link_id: string): Promise<IdentityLinkRecord | null>;
}

// ---------------------------------------------------------------------------
// In-memory adapter
// ---------------------------------------------------------------------------

/** Options accepted by the in-memory adapter. */
export interface InMemoryIdentityLinkRepositoryOptions {
  /** Wall-clock override. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /** UUIDv7 override. Defaults to the real `uuidv7()` generator. */
  readonly newId?: () => string;
}

/**
 * Pure in-memory `IdentityLinkRepository`. Suitable for unit tests, the
 * smoke harness, and bootstrap scenarios that run before PostgreSQL is
 * available.
 *
 * The adapter mirrors the SQL adapter's lookup semantics: only ACTIVE
 * rows (i.e. `superseded_at === null`) are returned from `findActive`.
 */
export class InMemoryIdentityLinkRepository implements IdentityLinkRepository {
  private readonly records: IdentityLinkRecord[] = [];
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: InMemoryIdentityLinkRepositoryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => uuidv7());
  }

  async findActive(input: FindActiveInput): Promise<ReadonlyArray<IdentityLinkRecord>> {
    return this.records.filter((record) => {
      if (record.superseded_at !== null) return false;
      if (record.project_id !== input.project_id) return false;
      if (record.environment !== input.environment) return false;
      const matches =
        record.left_identifier === input.identifier || record.right_identifier === input.identifier;
      if (!matches) return false;
      if (input.evidence_type !== undefined && record.evidence_type !== input.evidence_type) {
        return false;
      }
      return true;
    });
  }

  async insertLink(input: InsertLinkInput): Promise<IdentityLinkRecord> {
    const link_id = input.link_id ?? this.newId();
    const record: IdentityLinkRecord = {
      link_id,
      project_id: input.project_id,
      environment: input.environment,
      left_identifier: input.left_identifier,
      right_identifier: input.right_identifier,
      confidence: input.confidence,
      evidence_type: input.evidence_type,
      evidence: input.evidence,
      reason: input.reason,
      processor_name: input.processor_name,
      processor_version: input.processor_version,
      run_id: input.run_id ?? null,
      created_at: input.created_at ?? this.now(),
      superseded_at: null,
    };
    this.records.push(record);
    return record;
  }

  async supersedeLink(input: SupersedeLinkInput): Promise<IdentityLinkRecord> {
    const idx = this.records.findIndex((record) => record.link_id === input.link_id);
    if (idx === -1) {
      throw new Error(`identity-resolver: unknown link_id ${input.link_id}`);
    }
    const current = this.records[idx];
    if (current === undefined) {
      throw new Error(`identity-resolver: unknown link_id ${input.link_id}`);
    }
    if (current.superseded_at !== null) {
      // Idempotent: replaying a supersede on an already-retired row is a
      // no-op. The runtime relies on this so re-emits don't duplicate
      // retirements.
      return current;
    }
    const next: IdentityLinkRecord = {
      ...current,
      superseded_at: input.superseded_at ?? this.now(),
    };
    this.records[idx] = next;
    return next;
  }

  async findById(link_id: string): Promise<IdentityLinkRecord | null> {
    const found = this.records.find((record) => record.link_id === link_id);
    return found ?? null;
  }

  /** Snapshot the entire store. Useful for tests. */
  snapshot(): ReadonlyArray<IdentityLinkRecord> {
    return this.records.slice();
  }
}

// ---------------------------------------------------------------------------
// Kysely-backed adapter
// ---------------------------------------------------------------------------

/** Options accepted by the SQL-backed adapter. */
export interface KyselyIdentityLinkRepositoryOptions {
  readonly db: Kysely<Database>;
  /** Wall-clock override. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /** UUIDv7 override. Defaults to the real `uuidv7()` generator. */
  readonly newId?: () => string;
}

/**
 * Build a Kysely-backed `IdentityLinkRepository`. Implements the same
 * contract as the in-memory adapter.
 *
 * Notes on the SQL access pattern:
 *
 *   - `findActive` reads through the partial indexes
 *     `identity_links_left_active_idx` and `identity_links_right_active_idx`.
 *     The `OR` on left/right is intentional: graph traversal needs both
 *     directions and PostgreSQL's planner can union the partial-index hits.
 *
 *   - `insertLink` relies on the partial unique index
 *     `identity_links_active_pair_idx` to enforce idempotency on
 *     `(project_id, environment, left_identifier, right_identifier,
 *     evidence_type)` while a row is active. The runtime must call
 *     `findActive` first; this method does not catch the unique-violation
 *     error itself because the runtime needs the existing row for the
 *     event payload.
 *
 *   - `supersedeLink` is a no-op when the row already carries a
 *     `superseded_at` (matches the in-memory adapter).
 */
export function createKyselyIdentityLinkRepository(
  options: KyselyIdentityLinkRepositoryOptions,
): IdentityLinkRepository {
  const { db } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => uuidv7());

  async function findActive(input: FindActiveInput): Promise<ReadonlyArray<IdentityLinkRecord>> {
    let query = db
      .selectFrom("identity_links")
      .selectAll()
      .where("project_id", "=", input.project_id)
      .where("environment", "=", input.environment)
      .where("superseded_at", "is", null)
      .where((eb) =>
        eb.or([
          eb("left_identifier", "=", input.identifier),
          eb("right_identifier", "=", input.identifier),
        ]),
      );
    if (input.evidence_type !== undefined) {
      query = query.where("evidence_type", "=", input.evidence_type);
    }
    const rows = await query.execute();
    return rows.map(toRecord);
  }

  async function insertLink(input: InsertLinkInput): Promise<IdentityLinkRecord> {
    const link_id = input.link_id ?? newId();
    const created_at = input.created_at ?? now();
    const inserted = await db
      .insertInto("identity_links")
      .values({
        link_id,
        project_id: input.project_id,
        environment: input.environment,
        left_identifier: input.left_identifier,
        right_identifier: input.right_identifier,
        confidence: input.confidence,
        evidence_type: input.evidence_type,
        evidence: input.evidence,
        reason: input.reason,
        processor_name: input.processor_name,
        processor_version: input.processor_version,
        run_id: input.run_id ?? null,
        // Kysely's `ColumnType` for `created_at` accepts Date | string —
        // we hand it the value we computed so tests can pin it.
        created_at: created_at as unknown as never,
        superseded_at: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRecord(inserted);
  }

  async function supersedeLink(input: SupersedeLinkInput): Promise<IdentityLinkRecord> {
    const current = await findById(input.link_id);
    if (current === null) {
      throw new Error(`identity-resolver: unknown link_id ${input.link_id}`);
    }
    if (current.superseded_at !== null) {
      return current;
    }
    const supersededAt = input.superseded_at ?? now();
    const row = await db
      .updateTable("identity_links")
      .set({ superseded_at: supersededAt })
      .where("link_id", "=", input.link_id)
      .where("superseded_at", "is", null)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRecord(row);
  }

  async function findById(link_id: string): Promise<IdentityLinkRecord | null> {
    const row = await db
      .selectFrom("identity_links")
      .selectAll()
      .where("link_id", "=", link_id)
      .executeTakeFirst();
    return row === undefined ? null : toRecord(row);
  }

  return { findActive, insertLink, supersedeLink, findById };
}

interface IdentityLinkRow {
  link_id: string;
  project_id: string;
  environment: string;
  left_identifier: string;
  right_identifier: string;
  confidence: string;
  evidence_type: string;
  evidence: unknown;
  reason: string;
  processor_name: string;
  processor_version: string;
  run_id: string | null;
  created_at: Date;
  superseded_at: Date | null;
}

function toRecord(row: IdentityLinkRow): IdentityLinkRecord {
  return {
    link_id: row.link_id,
    project_id: row.project_id,
    environment: row.environment,
    left_identifier: row.left_identifier,
    right_identifier: row.right_identifier,
    confidence: asConfidence(row.confidence),
    evidence_type: row.evidence_type,
    evidence: toEvidenceRecord(row.evidence),
    reason: row.reason,
    processor_name: row.processor_name,
    processor_version: row.processor_version,
    run_id: row.run_id,
    created_at: row.created_at,
    superseded_at: row.superseded_at,
  };
}

function asConfidence(value: string): IdentityLinkConfidence {
  if (value === "authoritative" || value === "candidate") return value;
  // The CHECK constraint on the table rejects anything else; the cast
  // stays so a corrupted row produces a typed value rather than throwing
  // at the call site.
  return "candidate";
}

function toEvidenceRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
