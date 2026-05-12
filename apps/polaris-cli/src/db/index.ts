/**
 * Internal DB surface for the CLI. Re-exported through a small index so the
 * command layer never reaches into `./db/*` directly.
 */
export {
  type ApiKeyRow,
  findApiKeyById,
  insertApiKey,
  type InsertApiKeyInput,
  listApiKeysByProjectEnv,
  revokeApiKey,
} from "./api-keys.js";
export {
  AUDIT_ACTOR_SOURCES,
  AUDIT_ENVIRONMENTS,
  type AuditActorSource,
  type AuditEnvironment,
  type AuditRecordRow,
  type AuditRecordsTable,
  findAuditRecordById,
  insertAuditRecord,
  type InsertAuditRecordInput,
  listAuditRecords,
  type ListAuditRecordsFilter,
} from "./audit-records.js";
export { type ConnectDbOptions, type DbHandle, connectDb } from "./connect.js";
export {
  disableDestination,
  enableDestination,
  type DestinationRow,
  findDestinationById,
  insertDestination,
  type InsertDestinationInput,
  listAllDestinations,
  listDestinationsByProjectEnv,
  updateDestinationOps,
  type UpdateDestinationOpsInput,
} from "./destinations.js";
export {
  disableProcessorActivation,
  type DisableProcessorActivationInput,
  enableProcessorActivation,
  type EnableProcessorActivationInput,
  findActivationByKey,
  listActivationsForProcessor,
  listAllActivations,
  type ProcessorActivationKey,
  type ProcessorActivationRow,
} from "./processor-activations.js";
export {
  findOperatorTokenAuthRowById,
  findOperatorTokenById,
  insertOperatorToken,
  type InsertOperatorTokenInput,
  listOperatorTokens,
  OPERATOR_TOKEN_STATUSES,
  type OperatorTokenAuthRow,
  type OperatorTokenRow,
  type OperatorTokenStatus,
  type OperatorTokensTable,
  revokeOperatorToken,
  touchOperatorTokenLastUsedAt,
} from "./operator-tokens.js";
export {
  fetchAllProjects,
  fetchAllSources,
  fetchSourcesById,
  fetchSourcesByProject,
  insertProject,
  insertSource,
  updateProject,
  updateSource,
} from "./projects.js";
