/**
 * Repository helpers for the `destinations` table.
 *
 * `destinations` stores runtime instances of vendor-adapter consumers
 * (Meta CAPI, GA4, TikTok, Braze, webhook-sink, reverse-etl). One row per
 * deployed instance per `(project, environment)`. The row holds runtime
 * state and operational tuning only — mapping semantics live in versioned
 * consumer code under `consumers/<vendor>/v<n>/mappers/`.
 *
 * Rules baked into this module:
 *
 *   - The repository surface NEVER accepts mapping fields. There is no
 *     `field_map`, `event_map`, `target_field`, or any other column that
 *     would let a write path stash mapping semantics into PostgreSQL. The
 *     typed schema in `@polaris/shared-db` enforces this at compile time,
 *     and the CLI's argument validation rejects mapping-shaped flags before
 *     ever reaching this module.
 *
 *   - Status transitions are idempotent. `enable` and `disable` UPDATE
 *     unconditionally and return whether a real transition happened; the
 *     CLI surface decides what to show.
 *
 *   - `update-ops` only writes operational tuning columns. The function
 *     signature has no mapping fields.
 *
 * @see db/migrations/20260512000005_create_destinations.sql
 * @see packages/shared-db/src/database.ts DestinationsTable
 */
import type {
  Database,
  DestinationMode,
  DestinationRetryPolicy,
  DestinationStatus,
} from "@polaris/shared-db";
import type { Kysely } from "kysely";

/**
 * Read-shape returned to the command layer. Plain JSON, no Date — timestamps
 * stamped as ISO strings so JSON output matches the human form.
 */
export interface DestinationRow {
  readonly destination_id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly vendor: string;
  readonly instance_label: string;
  readonly secret_ref: string;
  readonly status: DestinationStatus;
  readonly mode: DestinationMode;
  readonly max_concurrency: number;
  readonly max_rps: number;
  readonly retry_policy: DestinationRetryPolicy;
  readonly dead_letter_threshold: number;
  readonly disabled_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * Insert input for `destinations create`. The caller has already validated
 * the closed-set fields and generated the `destination_id`.
 *
 * Intentionally has NO mapping fields. The repository function below cannot
 * accept event-to-vendor mapping data because the parameter type does not
 * carry it.
 */
export interface InsertDestinationInput {
  readonly destination_id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly vendor: string;
  readonly instance_label: string;
  readonly secret_ref: string;
  readonly mode: DestinationMode;
  readonly max_concurrency?: number;
  readonly max_rps?: number;
  readonly retry_policy?: DestinationRetryPolicy;
  readonly dead_letter_threshold?: number;
}

/**
 * Allowed update surface for `destinations update-ops`. Only operational
 * tuning. Adding a column here that resembles mapping semantics would be a
 * bug — the destinations DB test asserts the absence of such fields.
 */
export interface UpdateDestinationOpsInput {
  readonly max_concurrency?: number;
  readonly max_rps?: number;
  readonly retry_policy?: DestinationRetryPolicy;
  readonly dead_letter_threshold?: number;
}

/**
 * Insert one destination row. The migration's CHECK constraints and column
 * defaults handle status/mode/operational defaults; we explicitly carry
 * non-default values when the caller passes them.
 */
export async function insertDestination(
  db: Kysely<Database>,
  input: InsertDestinationInput,
): Promise<void> {
  const values: {
    destination_id: string;
    project_id: string;
    environment: string;
    vendor: string;
    instance_label: string;
    secret_ref: string;
    mode: DestinationMode;
    max_concurrency?: number;
    max_rps?: number;
    retry_policy?: DestinationRetryPolicy;
    dead_letter_threshold?: number;
  } = {
    destination_id: input.destination_id,
    project_id: input.project_id,
    environment: input.environment,
    vendor: input.vendor,
    instance_label: input.instance_label,
    secret_ref: input.secret_ref,
    mode: input.mode,
  };
  if (input.max_concurrency !== undefined) values.max_concurrency = input.max_concurrency;
  if (input.max_rps !== undefined) values.max_rps = input.max_rps;
  if (input.retry_policy !== undefined) values.retry_policy = input.retry_policy;
  if (input.dead_letter_threshold !== undefined) {
    values.dead_letter_threshold = input.dead_letter_threshold;
  }
  await db.insertInto("destinations").values(values).execute();
}

/**
 * Find one destination row by its public id. Returns `null` when no row
 * matches. The CLI uses this for the `show`, `enable`, `disable`, and
 * `update-ops` commands.
 */
export async function findDestinationById(
  db: Kysely<Database>,
  destinationId: string,
): Promise<DestinationRow | null> {
  const row = await db
    .selectFrom("destinations")
    .selectAll()
    .where("destination_id", "=", destinationId)
    .executeTakeFirst();
  if (row === undefined) return null;
  return toRow(row);
}

/**
 * List destinations scoped to one `(project_id, environment)` pair, sorted
 * by vendor then instance_label so operator output is stable.
 */
export async function listDestinationsByProjectEnv(
  db: Kysely<Database>,
  projectId: string,
  environment: string,
): Promise<DestinationRow[]> {
  const rows = await db
    .selectFrom("destinations")
    .selectAll()
    .where("project_id", "=", projectId)
    .where("environment", "=", environment)
    .orderBy("vendor")
    .orderBy("instance_label")
    .execute();
  return rows.map(toRow);
}

/**
 * List every destination across every project/environment. Used by
 * `polaris destinations list` when neither `--project` nor `--env` is set.
 */
export async function listAllDestinations(db: Kysely<Database>): Promise<DestinationRow[]> {
  const rows = await db
    .selectFrom("destinations")
    .selectAll()
    .orderBy("project_id")
    .orderBy("environment")
    .orderBy("vendor")
    .orderBy("instance_label")
    .execute();
  return rows.map(toRow);
}

/**
 * Transition a destination's `status` to `'active'` and clear
 * `disabled_reason`. Returns the number of rows that transitioned —
 * the CLI uses this to print "already active" idempotently.
 */
export async function enableDestination(
  db: Kysely<Database>,
  destinationId: string,
  now: Date,
): Promise<boolean> {
  const result = await db
    .updateTable("destinations")
    .set({
      status: "active",
      disabled_reason: null,
      updated_at: now,
    })
    .where("destination_id", "=", destinationId)
    .where("status", "<>", "active")
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}

/**
 * Transition a destination's `status` to `'disabled'` and stamp the
 * operator-supplied reason. Returns whether a real transition happened.
 */
export async function disableDestination(
  db: Kysely<Database>,
  destinationId: string,
  reason: string,
  now: Date,
): Promise<boolean> {
  const result = await db
    .updateTable("destinations")
    .set({
      status: "disabled",
      disabled_reason: reason,
      updated_at: now,
    })
    .where("destination_id", "=", destinationId)
    .where("status", "<>", "disabled")
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}

/**
 * Update operational tuning fields. Mapping semantics are intentionally
 * absent from the parameter shape; there is no path through this function
 * that can write event-to-vendor mapping data.
 */
export async function updateDestinationOps(
  db: Kysely<Database>,
  destinationId: string,
  patch: UpdateDestinationOpsInput,
  now: Date,
): Promise<boolean> {
  const set: {
    updated_at: Date;
    max_concurrency?: number;
    max_rps?: number;
    retry_policy?: DestinationRetryPolicy;
    dead_letter_threshold?: number;
  } = { updated_at: now };
  if (patch.max_concurrency !== undefined) set.max_concurrency = patch.max_concurrency;
  if (patch.max_rps !== undefined) set.max_rps = patch.max_rps;
  if (patch.retry_policy !== undefined) set.retry_policy = patch.retry_policy;
  if (patch.dead_letter_threshold !== undefined) {
    set.dead_letter_threshold = patch.dead_letter_threshold;
  }
  const result = await db
    .updateTable("destinations")
    .set(set)
    .where("destination_id", "=", destinationId)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}

function toRow(row: {
  readonly destination_id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly vendor: string;
  readonly instance_label: string;
  readonly secret_ref: string;
  readonly status: DestinationStatus;
  readonly mode: DestinationMode;
  readonly max_concurrency: number;
  readonly max_rps: number;
  readonly retry_policy: DestinationRetryPolicy;
  readonly dead_letter_threshold: number;
  readonly disabled_reason: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}): DestinationRow {
  return {
    destination_id: row.destination_id,
    project_id: row.project_id,
    environment: row.environment,
    vendor: row.vendor,
    instance_label: row.instance_label,
    secret_ref: row.secret_ref,
    status: row.status,
    mode: row.mode,
    max_concurrency: row.max_concurrency,
    max_rps: row.max_rps,
    retry_policy: row.retry_policy,
    dead_letter_threshold: row.dead_letter_threshold,
    disabled_reason: row.disabled_reason,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
