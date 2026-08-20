/**
 * Repository helpers for the `audit_records` table.
 *
 * The `audit_records` table is created by `db/migrations/20260512000007_create_audit_records.sql`
 * and owns every CLI mutation's audit row. The recorder in
 * `apps/polaris-cli/src/audit/recorder.ts` is the central write surface;
 * this module owns the typed Kysely SELECT / INSERT shapes the recorder and
 * the `audit` / `export audit` commands consume.
 *
 * The typed `AuditRecordsTable` interface extends `@polaris/shared-db`'s
 * `Database` interface through module augmentation — the comment block in
 * `libs/persistence/postgres/src/database.ts` documents the exact pattern. This
 * keeps the migration SQL the schema source-of-truth (the `Database`
 * interface in `shared-db` carries the columns of tables that have already
 * landed) while letting later tasks extend the typed surface from their own
 * package without an inter-package edit.
 *
 * Rules baked into this module:
 *
 *   - `audit_id` is UUIDv7 stored as text. The recorder generates it via
 *     the platform's `uuid.v7()` helper; callers never supply one.
 *   - `before` / `after` are arbitrary JSON snapshots; the recorder is the
 *     choke point that scrubs secret-resolved values from them. This
 *     module does NOT filter — its only job is to round-trip the JSON.
 *   - The repository never accepts `secret`, `token`, `plaintext`, or
 *     similar fields. The schema has no place to store them, and the
 *     callers (P6-003 keys, P6-004 destinations, P6-005 processors) emit
 *     secret references (`provider:ref`) only.
 *
 * @see db/migrations/20260512000007_create_audit_records.sql
 * @see apps/polaris-cli/src/audit/recorder.ts
 */
import type { Database } from "@polaris/shared-db";
import { POLARIS_ENVIRONMENTS, type PolarisEnvironment } from "@polaris/shared-environments";
import type { ColumnType, Kysely } from "kysely";

/**
 * Closed set of actor-source values, mirroring the
 * `audit_records_actor_source_allowed` CHECK in the migration.
 *
 * From `docs/architecture/02-control-plane.md` "Operator Identity and Audit
 * Actor":
 *
 *   - `declared`  — an authenticated principal from the control-plane
 *                   API: a verified bearer token, or an admin session
 *                   whose identity came from the IdP. NOT self-asserted;
 *                   nothing in Polaris accepts an unverified actor name.
 *   - `operator_token` — the CLI, after verifying an operator token's
 *                   secret against its argon2id hash and confirming the
 *                   row is active. Distinguished from `declared` so an
 *                   incident review can tell a CLI mutation from an
 *                   admin-panel one.
 *                   (display only; never authenticated in v1)
 *   - `cli`       — long-lived operator CLI session; the v1 default until
 *                   P6-007 wires `cli_token`
 *   - `migration` — schema/data migration writer (P11+)
 *   - `system`    — internal batch / scheduled job
 */
export const AUDIT_ACTOR_SOURCES = [
  "declared",
  "operator_token",
  "cli",
  "migration",
  "system",
] as const;
export type AuditActorSource = (typeof AUDIT_ACTOR_SOURCES)[number];

/**
 * Closed set of environment values, mirroring the existing pattern in
 * other migrations and the `audit_records_environment_allowed` CHECK.
 */
export const AUDIT_ENVIRONMENTS = POLARIS_ENVIRONMENTS;
export type AuditEnvironment = PolarisEnvironment;

/**
 * Typed mirror of the `audit_records` table.
 *
 * Extends `@polaris/shared-db`'s `Database` interface via module augmentation
 * (the `declare module` below) so any `Kysely<Database>` instance in the CLI
 * gets `db.selectFrom("audit_records")` typed automatically.
 */
export interface AuditRecordsTable {
  audit_id: string;
  created_at: ColumnType<Date, string | Date | undefined, never>;
  actor_source: AuditActorSource;
  actor_label: string;
  action: string;
  target_type: string;
  target_id: string;
  project_id: ColumnType<string | null, string | null | undefined, string | null>;
  environment: ColumnType<
    AuditEnvironment | null,
    AuditEnvironment | null | undefined,
    AuditEnvironment | null
  >;
  before: ColumnType<unknown | null, unknown | null | undefined, unknown | null>;
  after: ColumnType<unknown | null, unknown | null | undefined, unknown | null>;
  reason: ColumnType<string | null, string | null | undefined, string | null>;
  request_id: ColumnType<string | null, string | null | undefined, string | null>;
}

declare module "@polaris/shared-db" {
  interface Database {
    audit_records: AuditRecordsTable;
  }
}

/**
 * Read-shape returned to the command layer. Plain JSON: timestamps stamped
 * as ISO strings so the `human` and `json` renderers see the same value.
 */
export interface AuditRecordRow {
  readonly audit_id: string;
  readonly created_at: string;
  readonly actor_source: AuditActorSource;
  readonly actor_label: string;
  readonly action: string;
  readonly target_type: string;
  readonly target_id: string;
  readonly project_id: string | null;
  readonly environment: AuditEnvironment | null;
  readonly before: unknown | null;
  readonly after: unknown | null;
  readonly reason: string | null;
  readonly request_id: string | null;
}

/**
 * Input accepted by the recorder. Mirrors `AuditRecordRow` minus the
 * generated `created_at` (database default) and the recorder-supplied
 * `audit_id` (generated when omitted).
 */
export interface InsertAuditRecordInput {
  readonly audit_id: string;
  readonly actor_source: AuditActorSource;
  readonly actor_label: string;
  readonly action: string;
  readonly target_type: string;
  readonly target_id: string;
  readonly project_id?: string | null;
  readonly environment?: AuditEnvironment | null;
  readonly before?: unknown | null;
  readonly after?: unknown | null;
  readonly reason?: string | null;
  readonly request_id?: string | null;
  readonly created_at?: Date;
}

/**
 * Insert one audit row. Caller has already generated `audit_id` and
 * scrubbed any secret-resolved values from `before` / `after`.
 *
 * Returns the inserted row's `audit_id` so callers can correlate it back
 * to the calling command's log line.
 */
export async function insertAuditRecord(
  db: Kysely<Database>,
  input: InsertAuditRecordInput,
): Promise<void> {
  const values: {
    audit_id: string;
    actor_source: AuditActorSource;
    actor_label: string;
    action: string;
    target_type: string;
    target_id: string;
    project_id: string | null;
    environment: AuditEnvironment | null;
    before: unknown | null;
    after: unknown | null;
    reason: string | null;
    request_id: string | null;
    created_at?: Date;
  } = {
    audit_id: input.audit_id,
    actor_source: input.actor_source,
    actor_label: input.actor_label,
    action: input.action,
    target_type: input.target_type,
    target_id: input.target_id,
    project_id: input.project_id ?? null,
    environment: input.environment ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    reason: input.reason ?? null,
    request_id: input.request_id ?? null,
  };
  if (input.created_at !== undefined) values.created_at = input.created_at;
  await db.insertInto("audit_records").values(values).execute();
}

/**
 * Filter accepted by `polaris audit list` and `polaris export audit`.
 * Every field is optional and combined with AND.
 */
export interface ListAuditRecordsFilter {
  readonly actorLabel?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly action?: string;
  readonly projectId?: string;
  readonly environment?: AuditEnvironment;
  readonly since?: Date;
  readonly until?: Date;
  readonly limit?: number;
}

/**
 * Return audit rows matching the supplied filter, ordered by
 * `created_at DESC`. The default limit is 50 (matches `polaris audit list`'s
 * default). Bulk export callers pass an explicit larger limit.
 */
export async function listAuditRecords(
  db: Kysely<Database>,
  filter: ListAuditRecordsFilter,
): Promise<AuditRecordRow[]> {
  let query = db.selectFrom("audit_records").selectAll();
  if (filter.actorLabel !== undefined) {
    query = query.where("actor_label", "=", filter.actorLabel);
  }
  if (filter.targetType !== undefined) {
    query = query.where("target_type", "=", filter.targetType);
  }
  if (filter.targetId !== undefined) {
    query = query.where("target_id", "=", filter.targetId);
  }
  if (filter.action !== undefined) {
    query = query.where("action", "=", filter.action);
  }
  if (filter.projectId !== undefined) {
    query = query.where("project_id", "=", filter.projectId);
  }
  if (filter.environment !== undefined) {
    query = query.where("environment", "=", filter.environment);
  }
  if (filter.since !== undefined) {
    query = query.where("created_at", ">=", filter.since);
  }
  if (filter.until !== undefined) {
    query = query.where("created_at", "<=", filter.until);
  }
  const limit = filter.limit ?? 50;
  query = query.orderBy("created_at", "desc").limit(limit);
  const rows = await query.execute();
  return rows.map(toRow);
}

/**
 * Return one audit row by `audit_id`, or `null` when no row matches. Used
 * by `polaris audit show`.
 */
export async function findAuditRecordById(
  db: Kysely<Database>,
  auditId: string,
): Promise<AuditRecordRow | null> {
  const row = await db
    .selectFrom("audit_records")
    .selectAll()
    .where("audit_id", "=", auditId)
    .executeTakeFirst();
  if (row === undefined) return null;
  return toRow(row);
}

function toRow(row: {
  readonly audit_id: string;
  readonly created_at: Date;
  readonly actor_source: AuditActorSource;
  readonly actor_label: string;
  readonly action: string;
  readonly target_type: string;
  readonly target_id: string;
  readonly project_id: string | null;
  readonly environment: AuditEnvironment | null;
  readonly before: unknown | null;
  readonly after: unknown | null;
  readonly reason: string | null;
  readonly request_id: string | null;
}): AuditRecordRow {
  return {
    audit_id: row.audit_id,
    created_at: row.created_at.toISOString(),
    actor_source: row.actor_source,
    actor_label: row.actor_label,
    action: row.action,
    target_type: row.target_type,
    target_id: row.target_id,
    project_id: row.project_id,
    environment: row.environment,
    before: row.before,
    after: row.after,
    reason: row.reason,
    request_id: row.request_id,
  };
}
