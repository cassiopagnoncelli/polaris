/**
 * Repository helpers for the `processor_activations` table.
 *
 * Per `(processor_name, processor_version, project_id, environment)`, this
 * row records whether the processor is enabled in that scope. The CLI
 * (`polaris processors enable` / `disable`) upserts the runtime toggle, and
 * each processor's activation gate
 * (`@polaris/pipeline`'s `createProcessorActivationGate`) reads it per
 * message: a `disabled` row stops that processor from acting on that scope,
 * anything else lets the event through.
 *
 * Rules baked into this module:
 *
 *   - The repository surface NEVER accepts transform-rule fields. There is
 *     no `transform`, `rule`, `mapping`, `input_topic`, `output_topic`,
 *     `config_blob`, `routing`, or any other column that would let a write
 *     path stash processor semantics into PostgreSQL. The typed schema in
 *     `@polaris/persistence-postgres` enforces this at compile time, and the CLI's
 *     argument validation rejects rule-shaped flags before ever reaching
 *     this module.
 *
 *   - `enable` / `disable` upsert. Re-running with the same target state is
 *     idempotent; the helper returns whether a real transition happened so
 *     the CLI surface decides what to show ("already enabled" vs "enabled").
 *
 *   - Manifest semantic config (inputs, outputs, mode, defaults) is read by
 *     the catalog loader; it is NEVER written through this repository.
 *
 * @see db/postgres/migrations/20260512000006_create_processor_activations.sql
 * @see libs/persistence/postgres/src/database.ts ProcessorActivationsTable
 */
import type { Database, ProcessorActivationState } from "@polaris/persistence-postgres";
import type { Kysely } from "kysely";

/**
 * Read-shape returned to the command layer. Plain JSON, no Date — timestamps
 * are stamped as ISO strings so JSON output matches the human form.
 */
export interface ProcessorActivationRow {
  readonly processor_name: string;
  readonly processor_version: string;
  readonly project_id: string;
  readonly environment: string;
  readonly enabled_state: ProcessorActivationState;
  readonly enabled_at: string | null;
  readonly disabled_at: string | null;
  readonly last_changed_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * Tuple identifier for one activation row. Used by every helper since the
 * composite primary key has four columns.
 */
export interface ProcessorActivationKey {
  readonly processor_name: string;
  readonly processor_version: string;
  readonly project_id: string;
  readonly environment: string;
}

/**
 * Upsert input for `polaris processors enable`. The runner has already
 * validated the (name, version) pair exists in the on-disk manifest tree.
 *
 * Intentionally has NO transform-rule fields. The repository function below
 * cannot accept semantic processor data because the parameter type does
 * not carry it.
 */
export interface EnableProcessorActivationInput extends ProcessorActivationKey {
  readonly enabledAt: Date;
  readonly lastChangedBy: string;
}

export interface DisableProcessorActivationInput extends ProcessorActivationKey {
  readonly disabledAt: Date;
  readonly lastChangedBy: string;
}

/**
 * Find one activation row by its composite key. Returns `null` when no row
 * matches. Used by `enable` and `disable` to detect idempotent re-runs.
 */
export async function findActivationByKey(
  db: Kysely<Database>,
  key: ProcessorActivationKey,
): Promise<ProcessorActivationRow | null> {
  const row = await db
    .selectFrom("processor_activations")
    .selectAll()
    .where("processor_name", "=", key.processor_name)
    .where("processor_version", "=", key.processor_version)
    .where("project_id", "=", key.project_id)
    .where("environment", "=", key.environment)
    .executeTakeFirst();
  if (row === undefined) return null;
  return toRow(row);
}

/**
 * List every activation row across every scope. Ordered by
 * `(processor_name, processor_version, project_id, environment)` so output
 * is stable for operator-facing rendering.
 */
export async function listAllActivations(db: Kysely<Database>): Promise<ProcessorActivationRow[]> {
  const rows = await db
    .selectFrom("processor_activations")
    .selectAll()
    .orderBy("processor_name")
    .orderBy("processor_version")
    .orderBy("project_id")
    .orderBy("environment")
    .execute();
  return rows.map(toRow);
}

/**
 * List activations scoped to one `(processor_name, processor_version)` pair.
 * Used by `polaris processors show` to render the per-(project, env)
 * activation table next to the manifest.
 */
export async function listActivationsForProcessor(
  db: Kysely<Database>,
  processorName: string,
  processorVersion: string,
): Promise<ProcessorActivationRow[]> {
  const rows = await db
    .selectFrom("processor_activations")
    .selectAll()
    .where("processor_name", "=", processorName)
    .where("processor_version", "=", processorVersion)
    .orderBy("project_id")
    .orderBy("environment")
    .execute();
  return rows.map(toRow);
}

/**
 * Transition an activation row to `enabled`. UPSERTs against the composite
 * primary key: if no row exists yet, one is inserted; if a row exists with
 * `enabled_state = 'disabled'`, it is flipped to `enabled` and
 * `enabled_at`/`updated_at` are stamped. Returns whether a real transition
 * happened.
 *
 * Idempotent: re-running on an already-enabled row updates `updated_at` but
 * returns `false` so the CLI prints "already enabled".
 */
export async function enableProcessorActivation(
  db: Kysely<Database>,
  input: EnableProcessorActivationInput,
): Promise<boolean> {
  const existing = await findActivationByKey(db, input);
  if (existing === null) {
    await db
      .insertInto("processor_activations")
      .values({
        processor_name: input.processor_name,
        processor_version: input.processor_version,
        project_id: input.project_id,
        environment: input.environment,
        enabled_state: "enabled" as ProcessorActivationState,
        enabled_at: input.enabledAt,
        disabled_at: null,
        last_changed_by: input.lastChangedBy,
        updated_at: input.enabledAt,
      })
      .execute();
    return true;
  }
  if (existing.enabled_state === "enabled") {
    return false;
  }
  await db
    .updateTable("processor_activations")
    .set({
      enabled_state: "enabled" as ProcessorActivationState,
      enabled_at: input.enabledAt,
      last_changed_by: input.lastChangedBy,
      updated_at: input.enabledAt,
    })
    .where("processor_name", "=", input.processor_name)
    .where("processor_version", "=", input.processor_version)
    .where("project_id", "=", input.project_id)
    .where("environment", "=", input.environment)
    .execute();
  return true;
}

/**
 * Transition an activation row to `disabled`. UPSERTs against the composite
 * primary key: if no row exists yet, one is inserted in the disabled state
 * (rare but allowed — operators may want to pre-stage a disabled row);
 * otherwise the existing row's `enabled_state` flips and `disabled_at` is
 * stamped. Returns whether a real transition happened.
 */
export async function disableProcessorActivation(
  db: Kysely<Database>,
  input: DisableProcessorActivationInput,
): Promise<boolean> {
  const existing = await findActivationByKey(db, input);
  if (existing === null) {
    await db
      .insertInto("processor_activations")
      .values({
        processor_name: input.processor_name,
        processor_version: input.processor_version,
        project_id: input.project_id,
        environment: input.environment,
        enabled_state: "disabled" as ProcessorActivationState,
        enabled_at: null,
        disabled_at: input.disabledAt,
        last_changed_by: input.lastChangedBy,
        updated_at: input.disabledAt,
      })
      .execute();
    return true;
  }
  if (existing.enabled_state === "disabled") {
    return false;
  }
  await db
    .updateTable("processor_activations")
    .set({
      enabled_state: "disabled" as ProcessorActivationState,
      disabled_at: input.disabledAt,
      last_changed_by: input.lastChangedBy,
      updated_at: input.disabledAt,
    })
    .where("processor_name", "=", input.processor_name)
    .where("processor_version", "=", input.processor_version)
    .where("project_id", "=", input.project_id)
    .where("environment", "=", input.environment)
    .execute();
  return true;
}

function toRow(row: {
  readonly processor_name: string;
  readonly processor_version: string;
  readonly project_id: string;
  readonly environment: string;
  readonly enabled_state: ProcessorActivationState;
  readonly enabled_at: Date | null;
  readonly disabled_at: Date | null;
  readonly last_changed_by: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}): ProcessorActivationRow {
  return {
    processor_name: row.processor_name,
    processor_version: row.processor_version,
    project_id: row.project_id,
    environment: row.environment,
    enabled_state: row.enabled_state,
    enabled_at: row.enabled_at === null ? null : row.enabled_at.toISOString(),
    disabled_at: row.disabled_at === null ? null : row.disabled_at.toISOString(),
    last_changed_by: row.last_changed_by,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
