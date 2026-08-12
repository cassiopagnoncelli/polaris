/**
 * Operator-identity types used by the dispatcher (CLI today, control-plane
 * API tomorrow) and by the audit recorder downstream.
 *
 * The closed set of actor sources is the v1 model from
 * `docs/architecture/02-control-plane.md` "Operator Identity and Audit Actor":
 *
 *   - `declared`  — a workspace-authenticated operator. v1: a row in
 *                   `operator_tokens` whose plaintext we just verified.
 *                   This is the only source the production-mutation gate
 *                   accepts.
 *   - `cli`       — a local-dev shortcut. No token, no operator row, but
 *                   the CLI still records audit so a development run is
 *                   traceable. The gate refuses this source for production
 *                   mutations.
 *   - `migration` — schema/data migration writer. Out of scope for P6-007
 *                   but reserved here so audit rows from a P11+ migration
 *                   command can stamp the right value.
 *   - `system`    — internal batch / scheduled job. Same rationale.
 *
 * The set MUST stay in lockstep with:
 *
 *   - `audit_records_actor_source_allowed` CHECK constraint
 *     (`db/migrations/20260512000007_create_audit_records.sql`)
 *   - `AUDIT_ACTOR_SOURCES` constant
 *     (`apps/polaris-cli/src/db/audit-records.ts`)
 *
 * If a future migration widens the CHECK, widen this union in the same
 * change and let `tsc` find the call sites that need to handle the new
 * variant.
 */

/**
 * Closed set of actor-source values. See the module-level doc above for the
 * v1 semantics of each variant.
 */
export const ACTOR_SOURCES = ["declared", "operator_token", "cli", "migration", "system"] as const;

/** TS union of the actor-source values. */
export type ActorSource = (typeof ACTOR_SOURCES)[number];

/**
 * Result of resolving who is invoking the current command.
 *
 * `label` is the display string stamped onto audit rows (`actor_label`).
 * `tokenId` is the resolved `operator_tokens.operator_token_id` when the
 * resolver matched a row; absent for any other source.
 */
export interface ResolvedActor {
  readonly source: ActorSource;
  readonly label: string;
  readonly tokenId?: string;
}

/**
 * Type-guard for the closed set. The dispatcher gate, the audit recorder,
 * and the CLI's --output json renderer all use this to refuse a stray
 * string source value (e.g. a typo'd test fixture) at the boundary instead
 * of failing later inside a CHECK constraint.
 */
export function isActorSource(value: unknown): value is ActorSource {
  return typeof value === "string" && (ACTOR_SOURCES as readonly string[]).includes(value);
}
