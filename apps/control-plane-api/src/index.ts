/**
 * `@polaris/control-plane-api` — public module barrel.
 *
 * The binary entry point lives in `./server.ts`. This barrel exposes
 * the composable building blocks (`buildControlPlaneApp`, auth +
 * gate factories, audit recorder, operator-token repository factory)
 * so tests, smoke harnesses, and future P6 task wiring can drive the
 * API without forking the process.
 */
export { type BuildControlPlaneAppOptions, buildControlPlaneApp } from "./app.js";
export {
  AUDIT_ACTOR_SOURCES,
  AUDIT_ENVIRONMENTS,
  type AuditActorSource,
  type AuditEnvironment,
  type AuditRecorder,
  createKyselyAuditRecorder,
  InMemoryAuditRecorder,
  type RecordAuditInput,
} from "./audit/recorder.js";
export {
  type BearerAuthDeps,
  createBearerAuthPreHandler,
  INVALID_OPERATOR_TOKEN_CODE,
} from "./auth/bearer.js";
export { createMutationGatePreHandler, type MutationGateOptions } from "./auth/gate.js";
export {
  CONTROL_PLANE_SERVICE_NAME,
  type ControlPlaneConfig,
  controlPlaneConfigSchema,
  loadControlPlaneConfig,
} from "./config.js";
export { ControlPlaneMetrics } from "./metrics/registry.js";
export {
  createKyselyOperatorTokenRepository,
  OPERATOR_TOKEN_STATUSES,
  type OperatorTokenStatus,
  type OperatorTokensTable,
} from "./operators/repository.js";
