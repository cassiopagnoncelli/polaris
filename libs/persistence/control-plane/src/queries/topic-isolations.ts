/**
 * Repository helpers for the `topic_isolations` table.
 *
 * Per `docs/architecture/03-rabbitmq-streams.md` "Topic Isolation Triggers"
 * and "Topic Families", a project graduates from a shared canonical
 * topic (`raw.events`) to a dedicated topic (`raw.events.<project_id>`)
 * when an isolation trigger fires. The move is operational, not
 * structural — producer and consumer code references the family and
 * consults the resolver in `@polaris/bus` for the concrete
 * topic.
 *
 * This module owns the typed Kysely SELECT / INSERT / UPDATE surface
 * that the `polaris topics isolate` / `deisolate` CLI commands and the
 * Kysely-backed scoped lookup adapter consume.
 *
 * Rules baked into this module:
 *
 *   - **The resolver hot path goes through the adapter at the bottom
 *     of this file.** Production wires `createKyselyScopedIsolationLookup`
 *     and stacks a `StreamIsolationCache` on top so the per-publish
 *     PostgreSQL round trip is amortized to one query per TTL window.
 *
 *   - **One active isolation per (family, project_id, environment).**
 *     The migration's partial unique index enforces this; the
 *     `insertActiveIsolation` helper below INSERTs without a
 *     conflict-resolution clause so a duplicate activation surfaces as
 *     a typed error the CLI can show the operator.
 *
 *   - **Deactivation preserves history.** `deactivateIsolation` sets
 *     `deactivated_at = now()` instead of DELETE so an operator can
 *     reconstruct "when was this family isolated for this project?"
 *     without consulting the audit log.
 *
 * @see db/postgres/migrations/20260514000003_create_topic_isolations.sql
 * @see libs/persistence/postgres/src/database.ts TopicIsolationsTable
 * @see libs/bus/src/isolation-cache.ts
 */
import type { Database } from "@polaris/persistence-postgres";
import type { Kysely } from "kysely";

/**
 * Read-shape returned to the command layer. Plain JSON, no Date —
 * timestamps stamped as ISO strings so JSON output matches human form.
 */
export interface TopicIsolationRow {
  readonly id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly topic_family: string;
  readonly concrete_topic: string;
  readonly activated_at: string;
  readonly deactivated_at: string | null;
  readonly reason: string;
  readonly actor_id: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * Insert input for the `polaris topics isolate` command. The caller has
 * already validated the closed-set fields (family, environment) and
 * generated the `id`. The `concrete_topic` value is derived from the
 * `dedicatedStreamFamily` helper in `@polaris/bus`.
 */
export interface InsertTopicIsolationInput {
  readonly id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly topic_family: string;
  readonly concrete_topic: string;
  readonly reason: string;
  readonly actor_id: string;
}

/**
 * Insert one active isolation row. The migration's partial unique index
 * rejects a duplicate active triple; callers translate the resulting
 * PostgreSQL error into a typed CLI usage error.
 */
export async function insertTopicIsolation(
  db: Kysely<Database>,
  input: InsertTopicIsolationInput,
): Promise<void> {
  await db
    .insertInto("topic_isolations")
    .values({
      id: input.id,
      project_id: input.project_id,
      environment: input.environment,
      topic_family: input.topic_family,
      concrete_topic: input.concrete_topic,
      reason: input.reason,
      actor_id: input.actor_id,
    })
    .execute();
}

/**
 * Find the currently-active isolation row for a `(family, project_id,
 * environment)` triple, if any. Returns `null` when the project is on
 * the shared topic. The resolver adapter at the bottom of this file
 * uses this function on every cache miss.
 */
export async function findActiveIsolation(
  db: Kysely<Database>,
  topicFamily: string,
  projectId: string,
  environment: string,
): Promise<TopicIsolationRow | null> {
  const row = await db
    .selectFrom("topic_isolations")
    .selectAll()
    .where("topic_family", "=", topicFamily)
    .where("project_id", "=", projectId)
    .where("environment", "=", environment)
    .where("deactivated_at", "is", null)
    .executeTakeFirst();
  if (row === undefined) return null;
  return toRow(row);
}

/**
 * Find the most recently activated isolation row for a triple,
 * regardless of whether it is active or already deactivated. Used by
 * the `polaris topics deisolate` flow to surface a friendly "no such
 * active isolation" error when the operator targets a deactivated row.
 */
export async function findLatestIsolationByTriple(
  db: Kysely<Database>,
  topicFamily: string,
  projectId: string,
  environment: string,
): Promise<TopicIsolationRow | null> {
  const row = await db
    .selectFrom("topic_isolations")
    .selectAll()
    .where("topic_family", "=", topicFamily)
    .where("project_id", "=", projectId)
    .where("environment", "=", environment)
    .orderBy("activated_at", "desc")
    .executeTakeFirst();
  if (row === undefined) return null;
  return toRow(row);
}

/**
 * Find one isolation row by `id`. Used for audit / forensic queries.
 */
export async function findTopicIsolationById(
  db: Kysely<Database>,
  id: string,
): Promise<TopicIsolationRow | null> {
  const row = await db
    .selectFrom("topic_isolations")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (row === undefined) return null;
  return toRow(row);
}

/**
 * List all currently-active isolations. Used by operational tooling
 * that needs to drive consumer subscribe loops or render an inventory
 * dashboard.
 */
export async function listActiveIsolations(
  db: Kysely<Database>,
  filter: { readonly project_id?: string; readonly environment?: string } = {},
): Promise<TopicIsolationRow[]> {
  let query = db.selectFrom("topic_isolations").selectAll().where("deactivated_at", "is", null);
  if (filter.project_id !== undefined) {
    query = query.where("project_id", "=", filter.project_id);
  }
  if (filter.environment !== undefined) {
    query = query.where("environment", "=", filter.environment);
  }
  const rows = await query
    .orderBy("project_id")
    .orderBy("environment")
    .orderBy("topic_family")
    .execute();
  return rows.map(toRow);
}

/**
 * Deactivate one isolation row. Stamps `deactivated_at` and
 * `updated_at`; returns whether a real transition happened. Idempotent:
 * a second call on an already-deactivated row returns `false`.
 */
export async function deactivateIsolation(
  db: Kysely<Database>,
  id: string,
  now: Date,
): Promise<boolean> {
  const result = await db
    .updateTable("topic_isolations")
    .set({
      deactivated_at: now,
      updated_at: now,
    })
    .where("id", "=", id)
    .where("deactivated_at", "is", null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}

function toRow(row: {
  readonly id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly topic_family: string;
  readonly concrete_topic: string;
  readonly activated_at: Date;
  readonly deactivated_at: Date | null;
  readonly reason: string;
  readonly actor_id: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}): TopicIsolationRow {
  return {
    id: row.id,
    project_id: row.project_id,
    environment: row.environment,
    topic_family: row.topic_family,
    concrete_topic: row.concrete_topic,
    activated_at: row.activated_at.toISOString(),
    deactivated_at: row.deactivated_at === null ? null : row.deactivated_at.toISOString(),
    reason: row.reason,
    actor_id: row.actor_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
