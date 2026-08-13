/**
 * `project_config` reads, and the transaction-scoped writers the audited
 * mutations build on.
 *
 * The writers here are deliberately NOT exported from the package root — same
 * rule as `insertAuditRecord`. There must be no import path by which a caller
 * changes configuration without the audit row, the version bump, and the
 * notification that go with it.
 *
 * @see ../mutations/project-config.ts
 * @see db/migrations/20260813000001_create_project_config.sql
 */

import type { Database } from "@polaris/shared-db";
import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";

import type { AuditEnvironment } from "./audit-records.js";

/** Read shape of one configuration value. */
export interface ProjectConfigRow {
  readonly project_id: string;
  readonly environment: string;
  readonly namespace: string;
  readonly config_key: string;
  /**
   * The stored value. For `is_secret_ref` rows this is the
   * `<provider>:<ref>` pointer, never a resolved secret — the resolution
   * happens in `@polaris/shared-project-config` at read time and its result
   * never comes back here.
   */
  readonly value: unknown;
  readonly is_secret_ref: boolean;
  readonly updated_at: string;
  readonly updated_by: string;
}

export interface ListProjectConfigInput {
  readonly projectId: string;
  readonly environment: AuditEnvironment;
  /** Omit to list every namespace for the scope. */
  readonly namespace?: string | undefined;
}

export async function listProjectConfig(
  db: Kysely<Database>,
  input: ListProjectConfigInput,
): Promise<readonly ProjectConfigRow[]> {
  let query = db
    .selectFrom("project_config")
    .select([
      "project_id",
      "environment",
      "namespace",
      "config_key",
      "value",
      "is_secret_ref",
      "updated_at",
      "updated_by",
    ])
    .where("project_id", "=", input.projectId)
    .where("environment", "=", input.environment);

  if (input.namespace !== undefined) {
    query = query.where("namespace", "=", input.namespace);
  }

  const rows = await query.orderBy("namespace").orderBy("config_key").execute();
  return rows.map(toRow);
}

export interface ProjectConfigValueRef {
  readonly projectId: string;
  readonly environment: AuditEnvironment;
  readonly namespace: string;
  readonly configKey: string;
}

export async function findProjectConfigValue(
  db: Kysely<Database>,
  ref: ProjectConfigValueRef,
): Promise<ProjectConfigRow | undefined> {
  const row = await db
    .selectFrom("project_config")
    .select([
      "project_id",
      "environment",
      "namespace",
      "config_key",
      "value",
      "is_secret_ref",
      "updated_at",
      "updated_by",
    ])
    .where("project_id", "=", ref.projectId)
    .where("environment", "=", ref.environment)
    .where("namespace", "=", ref.namespace)
    .where("config_key", "=", ref.configKey)
    .executeTakeFirst();

  return row === undefined ? undefined : toRow(row);
}

/** Current version for a scope; `0n` when the scope has never been written. */
export async function readProjectConfigVersion(
  db: Kysely<Database>,
  projectId: string,
  environment: AuditEnvironment,
): Promise<bigint> {
  const row = await db
    .selectFrom("project_config_versions")
    .select("version")
    .where("project_id", "=", projectId)
    .where("environment", "=", environment)
    .executeTakeFirst();
  return row === undefined ? 0n : BigInt(row.version);
}

// ---------------------------------------------------------------------------
// Transaction-scoped writers — internal to ../mutations/project-config.ts
// ---------------------------------------------------------------------------

export interface UpsertProjectConfigInput extends ProjectConfigValueRef {
  readonly value: unknown;
  readonly isSecretRef: boolean;
  readonly updatedBy: string;
  readonly updatedAt: Date;
}

export async function upsertProjectConfigValue(
  trx: Transaction<Database>,
  input: UpsertProjectConfigInput,
): Promise<void> {
  await trx
    .insertInto("project_config")
    .values({
      project_id: input.projectId,
      environment: input.environment,
      namespace: input.namespace,
      config_key: input.configKey,
      value: sql`${JSON.stringify(input.value)}::jsonb`,
      is_secret_ref: input.isSecretRef,
      updated_at: input.updatedAt,
      updated_by: input.updatedBy,
    })
    .onConflict((oc) =>
      oc.columns(["project_id", "environment", "namespace", "config_key"]).doUpdateSet({
        value: sql`${JSON.stringify(input.value)}::jsonb`,
        is_secret_ref: input.isSecretRef,
        updated_at: input.updatedAt,
        updated_by: input.updatedBy,
      }),
    )
    .execute();
}

/** Returns false when the key did not exist — the caller writes no audit row. */
export async function deleteProjectConfigValue(
  trx: Transaction<Database>,
  ref: ProjectConfigValueRef,
): Promise<boolean> {
  const result = await trx
    .deleteFrom("project_config")
    .where("project_id", "=", ref.projectId)
    .where("environment", "=", ref.environment)
    .where("namespace", "=", ref.namespace)
    .where("config_key", "=", ref.configKey)
    .executeTakeFirst();

  return (result.numDeletedRows ?? 0n) > 0n;
}

/**
 * Increment the scope's version, creating the row at 1 when absent.
 *
 * The upsert matters: a scope's first-ever write has no
 * `project_config_versions` row, and a plain UPDATE would silently match
 * nothing — leaving readers on version 0 forever while values changed
 * underneath them.
 */
export async function bumpProjectConfigVersion(
  trx: Transaction<Database>,
  projectId: string,
  environment: AuditEnvironment,
  now: Date,
): Promise<bigint> {
  const row = await trx
    .insertInto("project_config_versions")
    .values({
      project_id: projectId,
      environment,
      version: 1,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.columns(["project_id", "environment"]).doUpdateSet({
        version: sql<number>`project_config_versions.version + 1`,
        updated_at: now,
      }),
    )
    .returning("version")
    .executeTakeFirstOrThrow();

  return BigInt(row.version);
}

/**
 * Announce a change on the channel `@polaris/shared-project-config` listens to.
 *
 * MUST run inside the mutation's transaction. PostgreSQL delivers `NOTIFY`
 * only when the transaction commits, which is what makes invalidation atomic
 * with the write — moving this outside would reintroduce the window where a
 * rolled-back write has already told every replica to drop its cache.
 *
 * The payload shape is the contract `parseConfigChangeMessage` parses; the
 * version is sent as a STRING so a value beyond 2^53 survives JSON.
 */
export async function notifyProjectConfigChanged(
  trx: Transaction<Database>,
  projectId: string,
  environment: AuditEnvironment,
  version: bigint,
): Promise<void> {
  const payload = JSON.stringify({
    project_id: projectId,
    environment,
    version: version.toString(),
  });
  await sql`SELECT pg_notify('polaris_config_changed', ${payload})`.execute(trx);
}

function toRow(row: {
  project_id: string;
  environment: string;
  namespace: string;
  config_key: string;
  value: unknown;
  is_secret_ref: boolean;
  updated_at: Date | string;
  updated_by: string;
}): ProjectConfigRow {
  return {
    project_id: row.project_id,
    environment: row.environment,
    namespace: row.namespace,
    config_key: row.config_key,
    value: row.value,
    is_secret_ref: row.is_secret_ref,
    updated_at:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    updated_by: row.updated_by,
  };
}
