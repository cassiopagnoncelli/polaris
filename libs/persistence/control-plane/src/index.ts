/**
 * @polaris/persistence-control-plane — control-plane data access shared by the
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
  ABORTABLE_CLICKHOUSE_REBUILD_JOB_STATUSES,
  CLICKHOUSE_REBUILD_JOB_STATUSES,
  type ClickhouseRebuildJobRow,
  type ClickhouseRebuildJobStatus,
  type ClickhouseRebuildJobsTable,
  findClickhouseRebuildJobById,
  type InsertClickhouseRebuildJobInput,
  isAbortableClickhouseRebuildStatus,
  isTerminalClickhouseRebuildStatus,
  type ListClickhouseRebuildJobsFilter,
  listClickhouseRebuildJobs,
  TERMINAL_CLICKHOUSE_REBUILD_JOB_STATUSES,
} from "./queries/clickhouse-rebuild-jobs.js";
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
  type DisableProcessorActivationInput,
  type EnableProcessorActivationInput,
  findActivationByKey,
  listActivationsForProcessor,
  listAllActivations,
  type ProcessorActivationRow,
} from "./queries/processor-activations.js";
export {
  findProcessorRunById,
  listProcessorRuns,
  type ProcessorRunRow,
  type ProcessorRunScope,
} from "./queries/processor-runs.js";
export {
  findProfileById,
  findProfileByIdentifier,
  findProfilesByIdentifierValue,
  type IdentifierLookup,
  type IdentityLinkRow,
  listIdentityLinks,
  listProfileIdentifiers,
  listProfileMerges,
  type ProfileIdentifierRow,
  type ProfileMergeRow,
  type ProfileRow,
} from "./queries/profiles.js";
export {
  findProjectConfigValue,
  type ListProjectConfigInput,
  listProjectConfig,
  type ProjectConfigRow,
  type ProjectConfigValueRef,
  readProjectConfigVersion,
  revealProjectConfigSecret,
} from "./queries/project-config.js";
export {
  fetchAllProjects,
  fetchAllSources,
  fetchSourcesById,
  fetchSourcesByProject,
  type ProjectFile,
  type ProjectRow,
  type SourceFile,
  type SourceRow,
} from "./queries/projects.js";
export {
  type CompleteReplayJobInput,
  type FailReplayJobInput,
  findReplayJobById,
  type InsertReplayJobInput,
  isTerminalReplayStatus,
  type ListReplayJobsFilter,
  listReplayJobs,
  type MarkReplayJobRunningInput,
  REPLAY_JOB_MODES,
  REPLAY_JOB_STATUSES,
  REPLAY_JOB_TARGETS,
  type RecordReplayChunkProgressInput,
  type ReplayJobMode,
  type ReplayJobRow,
  type ReplayJobStatus,
  type ReplayJobsTable,
  type ReplayJobTarget,
  TERMINAL_REPLAY_JOB_STATUSES,
} from "./queries/replay-jobs.js";
export {
  findActiveIsolation,
  findLatestIsolationByTriple,
  findTopicIsolationById,
  type InsertTopicIsolationInput,
  listActiveIsolations,
  type TopicIsolationRow,
} from "./queries/topic-isolations.js";

// ---- audited mutations --------------------------------------------------

export {
  type ApiKeyAuditSnapshot,
  revokeApiKeyWithAudit,
  toApiKeySnapshot,
} from "./mutations/api-keys.js";
export {
  IdleWindowTooShortError,
  PRUNABLE_ATTRIBUTION_VERSIONS,
  type PruneAttributionChainsInput,
  type PruneAttributionChainsResult,
  pruneAttributionChainsWithAudit,
  resolvePruneCutoff,
  UnprunableAttributionVersionError,
} from "./mutations/attribution-chains.js";
export {
  type AudienceMembershipRow,
  type AudienceScope,
  countOpenAudienceMemberships,
  enterAudience,
  exitAudience,
  listAudienceMemberships,
  listOpenAudienceMemberships,
  restampAudienceMemberships,
} from "./mutations/audience-memberships.js";
export type { AuditContext, AuditTarget, MutationOutcome } from "./mutations/audited.js";
export {
  type CatalogSyncOutcome,
  type CatalogSyncPlan,
  syncProjectsWithAudit,
  syncSourcesWithAudit,
} from "./mutations/catalog-sync.js";
export {
  abortClickhouseRebuildJobWithAudit,
  createClickhouseRebuildJobWithAudit,
  startClickhouseRebuildWithAudit,
} from "./mutations/clickhouse-rebuild-jobs.js";
export {
  createApiKeyWithAudit,
  createOperatorTokenWithAudit,
  type RotateApiKeyOutcome,
  revokeOperatorTokenWithAudit,
  rotateApiKeyWithAudit,
} from "./mutations/credentials.js";
export {
  createDestinationWithAudit,
  type DestinationAuditSnapshot,
  disableDestinationWithAudit,
  enableDestinationWithAudit,
  rotateDestinationSecretWithAudit,
  setDestinationReplayOptInWithAudit,
  toDestinationSnapshot,
  updateDestinationConfigWithAudit,
  updateDestinationOpsWithAudit,
} from "./mutations/destinations.js";
export {
  DLQ_RESOLUTION_NOTE_MAX_LENGTH,
  type DlqResolutionTarget,
  markDlqResolvedWithAudit,
  markProcessorDlqResolvedWithAudit,
  markProcessorDlqRetriedWithAudit,
} from "./mutations/dlq.js";
export {
  disableProcessorActivationWithAudit,
  enableProcessorActivationWithAudit,
  type ProcessorActivationKey,
  type ProcessorAuditSnapshot,
  processorTargetId,
  toProcessorSnapshot,
} from "./mutations/processor-activations.js";
export {
  type ProfilePlaneTruncateCounts,
  type TruncateProfilePlaneInput,
  truncateProfilePlaneWithAudit,
} from "./mutations/profile-plane.js";
export {
  applyProfileTraitChange,
  findProfilesWithTraits,
  type ProfileTraitsRow,
} from "./mutations/profile-traits.js";
export {
  type InvalidateProjectConfigInput,
  invalidateProjectConfigWithAudit,
  MaskedSecretWriteError,
  type ProjectConfigAuditSnapshot,
  type SetProjectConfigInput,
  setProjectConfigValueWithAudit,
  toProjectConfigSnapshot,
  type UnsetProjectConfigInput,
  unsetProjectConfigValueWithAudit,
} from "./mutations/project-config.js";
export {
  cancelReplayJobWithAudit,
  createReplayJobWithAudit,
  pauseReplayJobWithAudit,
  type ReplayAuditSnapshot,
  resumeReplayJobWithAudit,
  startReplayExecutionWithAudit,
  toReplaySnapshot,
} from "./mutations/replay-jobs.js";
export {
  deisolateTopicWithAudit,
  isolateTopicWithAudit,
} from "./mutations/topic-isolations.js";

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
