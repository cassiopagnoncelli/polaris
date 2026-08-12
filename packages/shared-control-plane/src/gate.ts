/**
 * Production-mutation dispatcher gate.
 *
 * One property per command (`mutates: boolean`), one rule. From
 * `docs/architecture/02-control-plane.md` "Operator Identity and Audit
 * Actor":
 *
 *   if command.mutates && environment === 'production'
 *       && actorSource !== 'declared':
 *     reject
 *   else:
 *     allow
 *
 * That's the entire gate. No risk tiers, no per-command lookup table, no
 * separately maintained list of "dangerous" command strings.
 *
 * The gate lives in `@polaris/shared-control-plane` (not in
 * `apps/polaris-cli`) so the future control-plane API can reuse the same
 * logic without a refactor. P6-000 (the control-plane API shell) will
 * import `enforceProductionMutationGate` and `resolveActor` from this
 * package and wire them to its HTTP request lifecycle.
 *
 * Denial reason code: `production_requires_authenticated_actor`. This
 * string is the v1 contract; downstream audit recorders (P6-006) pin it
 * into `audit_records.reason` / `audit_records.denied_reason` for
 * machine-readable filtering.
 *
 * @see docs/architecture/02-control-plane.md "Operator Identity and Audit Actor"
 * @see docs/architecture/11-production-readiness.md "Control-Plane Permissions"
 */
import type { ActorSource, ResolvedActor } from "./actor.js";
import type { OperatorGateMetricsSink } from "./metrics.js";

/**
 * Stable denial-reason code for the gate. Picked once here so the recorder
 * (`apps/polaris-cli/src/audit/recorder.ts`) and any future log-aggregation
 * tooling can grep for it without a free-text match.
 */
export const PRODUCTION_GATE_DENIED_REASON = "production_requires_authenticated_actor" as const;

export type ProductionGateDeniedReason = typeof PRODUCTION_GATE_DENIED_REASON;

/**
 * Closed set of environment values the gate understands. The CLI may run
 * against a non-production environment (development, staging, local) in
 * which case the gate is a no-op. Anything outside this set is treated as
 * "non-production" for safety; the dispatcher's argument parser is the
 * authoritative type-check on the env flag, this is a defensive check.
 */
export const GATE_ENVIRONMENTS = ["development", "staging", "production"] as const;
export type GateEnvironment = (typeof GATE_ENVIRONMENTS)[number];

/** Minimum command shape the gate consults. */
export interface GateCommand {
  /** Stable dotted id, e.g. `destinations.disable`. Used in error text. */
  readonly id: string;
  /** Whether the command performs a state-changing API call. */
  readonly mutates: boolean;
}

/**
 * Input the dispatcher hands to {@link enforceProductionMutationGate}.
 * `environment` is the EFFECTIVE environment of the call site — read
 * from `--env`, `POLARIS_ENV`, or absent (in which case the gate cannot
 * be a production gate and stays silent).
 */
export interface GateInput {
  readonly command: GateCommand;
  readonly environment: GateEnvironment | undefined;
  readonly actor: ResolvedActor;
  /**
   * Optional metrics sink. When supplied, the gate calls
   * `incrementGateDenial` once on every denial before throwing.
   * Allows the alert pipeline to observe gate denials without
   * the gate itself depending on a metrics package.
   */
  readonly metrics?: OperatorGateMetricsSink;
}

/**
 * Refusal raised when the gate rejects a command. The dispatcher catches
 * this, prints a clean stderr line, and exits with the right code (the
 * CLI maps to exit code 2, the usage-error class — operator can fix it by
 * setting `POLARIS_OPERATOR_TOKEN` or running against a non-production
 * environment).
 *
 * The error carries `commandId`, `environment`, `actorSource`, and
 * `reasonCode` as structured fields so the audit recorder can populate
 * its denied-decision row without re-parsing the message.
 */
export class ProductionMutationRefusedError extends Error {
  public override readonly name = "ProductionMutationRefusedError";
  public readonly commandId: string;
  public readonly environment: GateEnvironment;
  public readonly actorSource: ActorSource;
  public readonly reasonCode: ProductionGateDeniedReason;

  constructor(input: {
    readonly commandId: string;
    readonly environment: GateEnvironment;
    readonly actorSource: ActorSource;
  }) {
    super(
      `polaris ${input.commandId}: production mutation refused. ` +
        "Set POLARIS_OPERATOR_TOKEN to an active operator token issued via " +
        "`polaris operators create`, or run against a non-production " +
        "environment. (denied_reason=production_requires_authenticated_actor)",
    );
    this.commandId = input.commandId;
    this.environment = input.environment;
    this.actorSource = input.actorSource;
    this.reasonCode = PRODUCTION_GATE_DENIED_REASON;
  }
}

/**
 * Apply the v1 dispatcher rule. Throws {@link ProductionMutationRefusedError}
 * when the rule says deny. Returns `void` on allow — the caller proceeds.
 *
 * The dispatcher catches the refusal at the boundary and lets the audit
 * recorder persist a denied audit row before re-throwing for exit-code
 * translation. The gate itself stays pure: no DB writes, no logging.
 */
/**
 * Actor sources that clear the production gate.
 *
 * Both mean "a credential was verified", and the gate's question is only
 * whether anyone authenticated at all — not which credential they used:
 *
 *   - `operator_token` — the CLI verified an operator token's secret
 *     against its argon2id hash and confirmed the row is active.
 *   - `declared`       — the control-plane API authenticated a bearer
 *     token or an admin IdP session.
 *
 * `cli` (the resolver's fallback for every failed or absent credential)
 * and the machine sources are absent on purpose. Listing the allowed
 * sources rather than excluding `cli` means a future source has to be
 * added here deliberately, instead of clearing a production gate by
 * simply existing.
 */
const PRODUCTION_GATE_ALLOWED_SOURCES: ReadonlySet<string> = new Set([
  "declared",
  "operator_token",
]);

export function enforceProductionMutationGate(input: GateInput): void {
  if (!input.command.mutates) return;
  if (input.environment !== "production") return;
  if (PRODUCTION_GATE_ALLOWED_SOURCES.has(input.actor.source)) return;

  input.metrics?.incrementGateDenial({
    actor: input.actor.source,
    reason: PRODUCTION_GATE_DENIED_REASON,
  });

  throw new ProductionMutationRefusedError({
    commandId: input.command.id,
    environment: input.environment,
    actorSource: input.actor.source,
  });
}

/**
 * Type-guard on a string env value. Used by the dispatcher when reading
 * `--env` / `POLARIS_ENV` so a typo like `producton` fails closed (the
 * gate stays silent and the command runs in non-production mode) instead
 * of throwing.
 */
export function isGateEnvironment(value: unknown): value is GateEnvironment {
  return typeof value === "string" && (GATE_ENVIRONMENTS as readonly string[]).includes(value);
}
