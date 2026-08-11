/**
 * The unaudited writers, behind a deliberately unpleasant import path.
 *
 * The package root exports only `*WithAudit` mutations, so a caller reaching
 * these has to say so in an import line. That is the point: this module is a
 * migration affordance, not an escape hatch.
 *
 * Who legitimately uses it today:
 *
 *   - The `polaris` CLI, whose commands own their own transactions and
 *     already write their audit rows inside them. Those are tested and
 *     working; rewriting ~20 command sites onto `*WithAudit` is worthwhile
 *     but is its own change, not a rider on shipping the admin UI.
 *   - Creation paths that return show-once secrets (`insertApiKey`,
 *     `insertOperatorToken`), which stay CLI-only.
 *
 * Who must not: `apps/control-plane-api`. It imports the root only, so no
 * admin-UI mutation can skip its audit row. If that ever needs to change,
 * the reason belongs in a commit message.
 */

export { insertApiKey, revokeApiKey } from "./queries/api-keys.js";
export { type InsertAuditRecordInput, insertAuditRecord } from "./queries/audit-records.js";
export {
  disableDestination,
  disableDestinationReplay,
  enableDestination,
  enableDestinationReplay,
  insertDestination,
  updateDestinationOps,
} from "./queries/destinations.js";
export {
  insertOperatorToken,
  revokeOperatorToken,
  touchOperatorTokenLastUsedAt,
} from "./queries/operator-tokens.js";
export {
  type DisableProcessorActivationInput,
  disableProcessorActivation,
  type EnableProcessorActivationInput,
  enableProcessorActivation,
} from "./queries/processor-activations.js";
