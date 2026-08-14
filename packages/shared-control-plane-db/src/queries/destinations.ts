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
 *   - The read shape carries NO credential. `secret_value` holds a vendor
 *     credential in plaintext, and these readers feed `destinations show`,
 *     `destinations list`, the JSON export, the admin UI and every audit
 *     snapshot the mutation layer builds. {@link DESTINATION_READ_COLUMNS}
 *     omits it, so the credential does not leave PostgreSQL on any of those
 *     paths — not "is dropped later", does not leave. It is write-only through
 *     this module: `insertDestination` and `updateDestinationSecret` set it,
 *     and nothing here reads it back. The delivery runtime's own reader in
 *     `@polaris/shared-destinations` is the single consumer.
 *
 * @see db/migrations/20260512000005_create_destinations.sql
 * @see db/migrations/20260813000004_plaintext_project_secrets.sql
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
 *
 * The replay-opt-in trio (P7-004) ships alongside the existing operational
 * tuning columns. `replay_opt_in` is the authoritative gate the runtime
 * consults; the `reason` + `at` columns are surfaced to operators on
 * `polaris destinations show` so the most recent rationale is visible
 * without consulting the full audit history.
 */
export interface DestinationRow {
  readonly destination_id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly vendor: string;
  readonly instance_label: string;
  readonly status: DestinationStatus;
  readonly mode: DestinationMode;
  readonly max_concurrency: number;
  readonly max_rps: number;
  readonly retry_policy: DestinationRetryPolicy;
  readonly dead_letter_threshold: number;
  readonly disabled_reason: string | null;
  readonly replay_opt_in: boolean;
  /**
   * Per-instance configuration bag, the narrow half of the precedence chain
   * the routing gate reads. Parameters only — never mapping semantics, which
   * `updateDestinationConfigWithAudit` refuses at its write path, and never
   * credentials, which live in `secret_value`.
   */
  readonly config: Readonly<Record<string, unknown>>;
  readonly replay_opt_in_reason: string | null;
  readonly replay_opt_in_at: string | null;
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
  readonly secret_value: string;
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
 * Every column the operator-facing readers select — which is every column
 * except `secret_value`.
 *
 * Spelled out rather than `selectAll()`, and that is the whole point. Under
 * `selectAll()` the credential is fetched and then dropped by a projection,
 * so the guarantee rests on `toRow` continuing to omit it. Listing the columns
 * moves the guarantee into the SQL: a projection can be edited by accident, a
 * missing column cannot be read back by anyone.
 */
const DESTINATION_READ_COLUMNS = [
  "destination_id",
  "project_id",
  "environment",
  "vendor",
  "instance_label",
  "status",
  "mode",
  "max_concurrency",
  "max_rps",
  "retry_policy",
  "dead_letter_threshold",
  "disabled_reason",
  "replay_opt_in",
  "config",
  "replay_opt_in_reason",
  "replay_opt_in_at",
  "created_at",
  "updated_at",
] as const;

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
    secret_value: string;
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
    secret_value: input.secret_value,
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
    .select(DESTINATION_READ_COLUMNS)
    .where("destination_id", "=", destinationId)
    .executeTakeFirst();
  if (row === undefined) return null;
  return toRow(row);
}

/*
 * There is deliberately no `revealDestinationSecret` here.
 *
 * A destination credential is WRITE-ONLY through every Polaris surface: set by
 * `destinations create`, replaced by `destinations rotate-secret`, and read
 * back by exactly one consumer — the delivery runtime, through its own narrow
 * reader in `@polaris/shared-destinations`. No CLI verb, page or export can
 * print it.
 *
 * The same rule `api_keys.hash` follows, and for the same reason: nothing an
 * operator does needs the current value. "Is this destination wired
 * correctly?" is answered by its delivery history — an `auth` error class on
 * recent rows — and "I need a different credential" is answered by rotating.
 * Adding a read path would create a disclosure route to serve neither.
 *
 * `project_config` differs and has `revealProjectConfigSecret`, because those
 * rows are general configuration an operator inspects routinely and only some
 * of them are sensitive.
 */

/**
 * Replace one destination's credential.
 *
 * Rotation has to live somewhere now that the credential IS the stored value.
 * While the column held a `provider:ref` pointer, rotating meant changing the
 * secret behind the pointer in Vault and Polaris had nothing to do; the row
 * never changed. Without this, the only ways to change a live credential would
 * be recreating the destination or direct SQL.
 *
 * Returns whether a row matched. No `WHERE secret_value <> $new` guard: a
 * comparison would need the old value in this process for nothing, and
 * re-setting a credential to itself is a harmless no-op that an operator
 * re-pasting after a failed attempt will do routinely.
 */
export async function updateDestinationSecret(
  db: Kysely<Database>,
  destinationId: string,
  secretValue: string,
  now: Date,
): Promise<boolean> {
  const result = await db
    .updateTable("destinations")
    .set({ secret_value: secretValue, updated_at: now })
    .where("destination_id", "=", destinationId)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
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
    .select(DESTINATION_READ_COLUMNS)
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
    .select(DESTINATION_READ_COLUMNS)
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
 * Transition a destination's `replay_opt_in` column to `true` and stamp
 * the operator-supplied reason + opt-in timestamp (P7-004).
 *
 * Returns whether a real transition happened: the UPDATE filters on
 * `replay_opt_in = false` so a second invocation against an already
 * opted-in row touches zero rows and the CLI surfaces "already opted in"
 * idempotently. The CHECK constraint
 * `destinations_replay_opt_in_reason_when_enabled` enforces that the
 * reason is non-empty when the column is flipped on.
 */
export async function enableDestinationReplay(
  db: Kysely<Database>,
  destinationId: string,
  reason: string,
  now: Date,
): Promise<boolean> {
  const result = await db
    .updateTable("destinations")
    .set({
      replay_opt_in: true,
      replay_opt_in_reason: reason,
      replay_opt_in_at: now,
      updated_at: now,
    })
    .where("destination_id", "=", destinationId)
    .where("replay_opt_in", "=", false)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}

/**
 * Transition a destination's `replay_opt_in` column to `false` and stamp
 * the operator-supplied reason (P7-004).
 *
 * The `replay_opt_in_at` column is intentionally NOT cleared: operators
 * may want to see the most recent time replay was active even after
 * it has been turned off. The boolean is the authoritative gate.
 */
export async function disableDestinationReplay(
  db: Kysely<Database>,
  destinationId: string,
  reason: string,
  now: Date,
): Promise<boolean> {
  const result = await db
    .updateTable("destinations")
    .set({
      replay_opt_in: false,
      replay_opt_in_reason: reason,
      updated_at: now,
    })
    .where("destination_id", "=", destinationId)
    .where("replay_opt_in", "=", true)
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

/**
 * Replace one destination instance's `config` bag.
 *
 * Whole-bag replacement rather than a merge. A merge would make removing a
 * key impossible through this path, and the bag is small enough that an
 * operator can restate it — the routing gate reads it as a unit anyway.
 *
 * The mapping guard is applied by the caller, before any database access,
 * so a refused write leaves no trace. It is not applied here because this
 * function is the mechanical write and the guard belongs where the audit
 * record is decided.
 */
export async function updateDestinationConfig(
  db: Kysely<Database>,
  destinationId: string,
  config: Readonly<Record<string, unknown>>,
  now: Date,
): Promise<boolean> {
  const result = await db
    .updateTable("destinations")
    .set({ updated_at: now, config })
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
  readonly status: DestinationStatus;
  readonly mode: DestinationMode;
  readonly max_concurrency: number;
  readonly max_rps: number;
  readonly retry_policy: DestinationRetryPolicy;
  readonly dead_letter_threshold: number;
  readonly disabled_reason: string | null;
  readonly replay_opt_in: boolean;
  readonly config: Readonly<Record<string, unknown>>;
  readonly replay_opt_in_reason: string | null;
  readonly replay_opt_in_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}): DestinationRow {
  return {
    destination_id: row.destination_id,
    project_id: row.project_id,
    environment: row.environment,
    vendor: row.vendor,
    instance_label: row.instance_label,
    status: row.status,
    mode: row.mode,
    max_concurrency: row.max_concurrency,
    max_rps: row.max_rps,
    retry_policy: row.retry_policy,
    dead_letter_threshold: row.dead_letter_threshold,
    disabled_reason: row.disabled_reason,
    replay_opt_in: row.replay_opt_in,
    config: row.config,
    replay_opt_in_reason: row.replay_opt_in_reason,
    replay_opt_in_at: row.replay_opt_in_at === null ? null : row.replay_opt_in_at.toISOString(),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
