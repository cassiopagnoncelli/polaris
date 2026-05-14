/**
 * `@polaris/control-plane-api` — public module barrel.
 *
 * The binary entry point lives in `./server.ts`. This barrel exposes
 * the composable building blocks (`buildControlPlaneApp`, auth +
 * gate factories, audit recorder, operator-token repository factory)
 * so tests, smoke harnesses, and future P6 task wiring can drive the
 * API without forking the process.
 */
export { buildControlPlaneApp, type BuildControlPlaneAppOptions } from "./app.js";
export {
  CONTROL_PLANE_SERVICE_NAME,
  controlPlaneConfigSchema,
  loadControlPlaneConfig,
  type ControlPlaneConfig,
} from "./config.js";
export {
  createBearerAuthPreHandler,
  INVALID_OPERATOR_TOKEN_CODE,
  type BearerAuthDeps,
} from "./auth/bearer.js";
export { createMutationGatePreHandler, type MutationGateOptions } from "./auth/gate.js";
export {
  AUDIT_ACTOR_SOURCES,
  AUDIT_ENVIRONMENTS,
  createKyselyAuditRecorder,
  InMemoryAuditRecorder,
  type AuditActorSource,
  type AuditEnvironment,
  type AuditRecorder,
  type RecordAuditInput,
} from "./audit/recorder.js";
export {
  createKyselyOperatorTokenRepository,
  OPERATOR_TOKEN_STATUSES,
  type OperatorTokenStatus,
  type OperatorTokensTable,
} from "./operators/repository.js";
export { ControlPlaneMetrics } from "./metrics/registry.js";
