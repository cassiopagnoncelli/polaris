/**
 * @polaris/shared-control-plane-db — control-plane data access shared by the
 * `polaris` CLI and the control-plane API.
 *
 * ## What this package is for
 *
 * Two surfaces now write control-plane state: the CLI, and the admin UI
 * inside `apps/control-plane-api`. Reads diverging between them is cosmetic.
 * Writes diverging is a correctness bug — a different `WHERE status <> …`
 * guard, a missed `disabled_reason` clear, a differently shaped audit
 * snapshot — and the kind that shows up months later in an audit trail
 * nobody can reconcile. So the writes live here, once.
 *
 * ## The export boundary is the design
 *
 * Note what is **not** exported below: `insertAuditRecord`, and the bare
 * writers `enableDestination`, `disableDestination`, `revokeApiKey`,
 * `enableProcessorActivation`, `disableProcessorActivation`.
 *
 * They are internal on purpose. The only way to perform one of those
 * mutations from outside this package is through its `*WithAudit` function,
 * which owns the transaction and writes the audit row in it. There is no
 * import path that mutates control-plane state without an audit record —
 * which is the property `docs/architecture/02-control-plane.md` names as
 * reason #1 the control-plane API exists, expressed as a package boundary
 * rather than as a convention each caller has to remember.
 *
 * Reads are exported freely; they cannot lose an audit row.
 *
 * @see docs/architecture/02-control-plane.md "Implementation shape"
 */

// ---- reads --------------------------------------------------------------

export {
  type ApiKeyRow,
  findApiKeyById,
  type InsertApiKeyInput,
  listApiKeysByProjectEnv,
} from "./queries/api-keys.js";
export {
  AUDIT_ACTOR_SOURCES,
  AUDIT_ENVIRONMENTS,
  type AuditActorSource,
  type AuditEnvironment,
  type AuditRecordRow,
  type AuditRecordsTable,
  findAuditRecordById,
  type ListAuditRecordsFilter,
  listAuditRecords,
} from "./queries/audit-records.js";
export {
  type DestinationRow,
  findDestinationById,
  type InsertDestinationInput,
  listAllDestinations,
  listDestinationsByProjectEnv,
  type UpdateDestinationOpsInput,
} from "./queries/destinations.js";
export {
  findOperatorTokenAuthRowById,
  findOperatorTokenById,
  type InsertOperatorTokenInput,
  listOperatorTokens,
  OPERATOR_TOKEN_STATUSES,
  type OperatorTokenAuthRow,
  type OperatorTokenRow,
  type OperatorTokenStatus,
  type OperatorTokensTable,
} from "./queries/operator-tokens.js";
export {
  findActivationByKey,
  listActivationsForProcessor,
  listAllActivations,
  type ProcessorActivationRow,
} from "./queries/processor-activations.js";

// ---- audited mutations --------------------------------------------------

export {
  type ApiKeyAuditSnapshot,
  revokeApiKeyWithAudit,
  toApiKeySnapshot,
} from "./mutations/api-keys.js";
export type { AuditContext, AuditTarget, MutationOutcome } from "./mutations/audited.js";
export {
  type DestinationAuditSnapshot,
  disableDestinationWithAudit,
  enableDestinationWithAudit,
  toDestinationSnapshot,
} from "./mutations/destinations.js";
export {
  disableProcessorActivationWithAudit,
  enableProcessorActivationWithAudit,
  type ProcessorActivationKey,
  type ProcessorAuditSnapshot,
  processorTargetId,
  toProcessorSnapshot,
} from "./mutations/processor-activations.js";

// ---- deliberately internal ----------------------------------------------
//
// insertAuditRecord                    -> use a *WithAudit mutation
// enableDestination / disableDestination
// revokeApiKey
// enableProcessorActivation / disableProcessorActivation
// insertApiKey / insertDestination / insertOperatorToken / revokeOperatorToken
// touchOperatorTokenLastUsedAt
//
// The CLI still needs several of these while its commands own their own
// transactions; it reaches them through `./internal.js` rather than the root,
// so the unaudited path is visible in an import line rather than hidden in a
// barrel. See `apps/polaris-cli/src/db/index.ts`.
