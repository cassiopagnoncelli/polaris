/**
 * Authorization and confirmation for admin mutations.
 *
 * ## Why the production-mutation gate is not used here
 *
 * `enforceProductionMutationGate` refuses exactly one thing: an actor whose
 * `source` is not `declared`. Every operator who gets past the admin session
 * guard resolves to `declared` by construction. So the gate passes for all of
 * them, always. It is not a guardrail on this surface, and wiring it in would
 * be worse than useless — it would look like protection while providing none.
 *
 * It is also keyed on the **service's** `POLARIS_ENV` rather than the target
 * row's `environment` column (see `../../auth/gate.ts`, "Service environment
 * string read from runtime config"). One control plane fronting one Postgres
 * that holds development, staging, and production rows therefore never
 * engages the gate for production data unless the service itself is deployed
 * as production. That is pre-existing and shared with the CLI.
 *
 * ## What replaces it
 *
 * Three things, in order of how much work they do:
 *
 *   1. **Resolve the row, gate on ITS environment.** The check happens in the
 *      handler, after the fetch — a preHandler runs before the target is
 *      known, which is precisely the bug above.
 *   2. **Escalate for production.** Reads and non-production mutations need
 *      `admin`; a production row needs `POLARIS_ADMIN_PRODUCTION_MIN_ROLE`
 *      (default `owner`). This costs about five lines because Idp already
 *      ranks owner > admin > member > viewer > none, and it is the only real
 *      authorization distinction the platform has.
 *   3. **Typed confirmation plus a reason.** See `confirmationMatches`.
 */

import type { AdminConfig } from "../config.js";
import { type PlatformRoleName, platformRoleAtLeast } from "../platform-role.js";

/** Minimum length for an operator-supplied reason. */
export const MIN_REASON_LENGTH = 10;

export type MutationRefusal =
  | { kind: "role"; required: PlatformRoleName; actual: PlatformRoleName; environment: string }
  | { kind: "confirmation"; expected: string }
  | { kind: "reason" };

export type MutationCheck = { ok: true; reason: string } | { ok: false; refusal: MutationRefusal };

export interface MutationRequest {
  /** Environment of the row being mutated — not of the service. */
  readonly rowEnvironment: string;
  /** The role of the operator making the request. */
  readonly role: PlatformRoleName;
  /** What the operator typed into the confirmation field. */
  readonly confirmation: string;
  /** The human-readable label they had to type. */
  readonly expectedConfirmation: string;
  /** What the operator typed into the reason field. */
  readonly reason: string;
}

/**
 * Decide whether a mutation may proceed.
 *
 * Order matters: role first, so an operator who is not allowed to act at all
 * is told that rather than being sent to fix their typing and then refused.
 */
export function checkMutation(config: AdminConfig, request: MutationRequest): MutationCheck {
  const required = requiredRoleFor(config, request.rowEnvironment);
  if (!platformRoleAtLeast(request.role, required)) {
    return {
      ok: false,
      refusal: {
        kind: "role",
        required,
        actual: request.role,
        environment: request.rowEnvironment,
      },
    };
  }

  if (!confirmationMatches(request.confirmation, request.expectedConfirmation)) {
    return { ok: false, refusal: { kind: "confirmation", expected: request.expectedConfirmation } };
  }

  const reason = request.reason.trim();
  if (reason.length < MIN_REASON_LENGTH) {
    return { ok: false, refusal: { kind: "reason" } };
  }

  return { ok: true, reason };
}

/** The role needed to mutate a row in this environment. */
export function requiredRoleFor(config: AdminConfig, rowEnvironment: string): PlatformRoleName {
  return rowEnvironment === "production" ? config.productionMinRole : "admin";
}

/**
 * Compare the typed confirmation against the resource's human label.
 *
 * Deliberately the **label** (`instance_label`, `processor_name`,
 * `source_id`), never the `polaris_dst_<uuid>` identifier. Nobody transcribes
 * a UUID — they copy-paste it, which turns the ritual into two keystrokes and
 * defeats the entire point. A memorable name forces the operator to actually
 * read what they are about to change.
 *
 * Whitespace is trimmed; case is not folded. If it does not match, it does
 * not match.
 */
export function confirmationMatches(typed: string, expected: string): boolean {
  return typed.trim() === expected.trim() && expected.trim().length > 0;
}

/** One-line explanation for the operator. */
export function describeRefusal(refusal: MutationRefusal): string {
  switch (refusal.kind) {
    case "role":
      return `Mutating a ${refusal.environment} resource requires the ${refusal.required} platform role. Yours is ${refusal.actual}.`;
    case "confirmation":
      return `Type ${refusal.expected} exactly to confirm.`;
    case "reason":
      return `Give a reason of at least ${MIN_REASON_LENGTH} characters. It is recorded in the audit log.`;
  }
}
