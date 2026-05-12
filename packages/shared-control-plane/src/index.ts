/**
 * `@polaris/shared-control-plane` — control-plane primitives shared between
 * the `polaris` CLI (today) and the future `apps/control-plane-api/`
 * service.
 *
 * The package exports two narrow responsibilities:
 *
 *   1. Operator identity. Closed-set `ActorSource` type, `ResolvedActor`
 *      shape, and `resolveActor(...)` which reads the env var, looks up
 *      the row through an injected repository, verifies the secret tail,
 *      and returns the resolved actor (or the `cli` fallback). The
 *      `polaris_ot_<uuidv7>.<base64url-32B>` wire format and its parser
 *      live in `./token-format`.
 *
 *   2. Dispatcher rule. `enforceProductionMutationGate(...)` applies the
 *      v1 rule:
 *
 *        if mutates && env === 'production' && source !== 'declared':
 *          refuse with ProductionMutationRefusedError
 *
 *      `PRODUCTION_GATE_DENIED_REASON` carries the audit reason code so the
 *      recorder pins the same string into `audit_records.reason` on denial.
 *
 * Both pieces are independent of the CLI shell. The CLI imports them; a
 * future control-plane API will import the same symbols when it lands.
 *
 * @see docs/architecture/02-control-plane.md "Operator Identity and Audit Actor"
 * @see docs/architecture/11-production-readiness.md "Control-Plane Permissions"
 * @see docs/implementation/tasks/P6-007-operator-tokens-and-mutation-gate.md
 */

export {
  ACTOR_SOURCES,
  type ActorSource,
  type ResolvedActor,
  isActorSource,
} from "./actor.js";

export {
  formatOperatorToken,
  OPERATOR_TOKEN_ID_PREFIX,
  OPERATOR_TOKEN_SEPARATOR,
  parseOperatorToken,
  type ParsedOperatorToken,
} from "./token-format.js";

export {
  CLI_FALLBACK_LABEL,
  OPERATOR_TOKEN_ENV_VAR,
  type OperatorTokenRepository,
  type OperatorTokenRow,
  type ResolveActorOptions,
  resolveActor,
} from "./resolver.js";

export {
  enforceProductionMutationGate,
  GATE_ENVIRONMENTS,
  type GateCommand,
  type GateEnvironment,
  type GateInput,
  isGateEnvironment,
  PRODUCTION_GATE_DENIED_REASON,
  type ProductionGateDeniedReason,
  ProductionMutationRefusedError,
} from "./gate.js";
