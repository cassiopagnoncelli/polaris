/**
 * `project_config` reads, and the transaction-scoped writers the audited
 * mutations build on.
 *
 * The writers here are deliberately NOT exported from the package root — same
 * rule as `insertAuditRecord`. There must be no import path by which a caller
 * changes configuration without the audit row, the version bump, and the
 * notification that go with it.
 *
 * The readers apply the same principle to disclosure. Secret values are stored
 * plaintext, so every generic read here MASKS them and only
 * {@link revealProjectConfigSecret} returns one — there must be no import path
 * by which a caller accidentally puts a credential in a list view, an export or
 * an audit snapshot.
 *
 * @see ../mutations/project-config.ts
 * @see db/migrations/20260813000001_create_project_config.sql
 * @see db/migrations/20260813000004_plaintext_project_secrets.sql
 */

import { maskIfSecret } from "@polaris/shared-control-plane";
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
   * The stored value — or `SECRET_MASK` when `is_secret` is true.
   *
   * Masked here rather than at each call site, because the call sites are
   * list views, `show` output, exports and audit snapshots: nine of them, all
   * one forgotten mask away from writing a credential somewhere durable. A
   * caller that genuinely needs the plaintext calls
   * {@link revealProjectConfigSecret}, which is greppable.
   */
  readonly value: unknown;
  /** Whether the value is sensitive, and therefore masked above. */
  readonly is_secret: boolean;
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
      "is_secret",
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
      "is_secret",
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

/**
 * Read one value WITHOUT masking — the deliberate disclosure path.
 *
 * The only way plaintext leaves this module. Two callers are legitimate: the
 * admin UI's explicit reveal action, and `polaris config get --reveal`. Both
 * are operator-initiated and both show the value to a human who already holds
 * control-plane credentials.
 *
 * Named so that a reviewer asking "where can a stored secret escape?" gets the
 * complete answer from one grep. Returns `undefined` when the key does not
 * exist, and for a non-secret key returns the value unchanged — a caller that
 * revealed something harmless has still done nothing wrong.
 */
export async function revealProjectConfigSecret(
  db: Kysely<Database>,
  ref: ProjectConfigValueRef,
): Promise<unknown | undefined> {
  const row = await db
    .selectFrom("project_config")
    .select("value")
    .where("project_id", "=", ref.projectId)
    .where("environment", "=", ref.environment)
    .where("namespace", "=", ref.namespace)
    .where("config_key", "=", ref.configKey)
    .executeTakeFirst();

  return row === undefined ? undefined : row.value;
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
  readonly isSecret: boolean;
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
      is_secret: input.isSecret,
      updated_at: input.updatedAt,
      updated_by: input.updatedBy,
    })
    .onConflict((oc) =>
      oc.columns(["project_id", "environment", "namespace", "config_key"]).doUpdateSet({
        value: sql`${JSON.stringify(input.value)}::jsonb`,
        is_secret: input.isSecret,
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
  is_secret: boolean;
  updated_at: Date | string;
  updated_by: string;
}): ProjectConfigRow {
  return {
    project_id: row.project_id,
    environment: row.environment,
    namespace: row.namespace,
    config_key: row.config_key,
    // The single choke point. Every generic read in this module funnels
    // through here, so masking cannot be forgotten by adding a query.
    value: maskIfSecret(row.value, row.is_secret),
    is_secret: row.is_secret,
    updated_at:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    updated_by: row.updated_by,
  };
}
