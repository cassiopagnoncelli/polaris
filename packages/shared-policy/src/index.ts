/**
 * `@polaris/shared-policy` — forbidden-field policy evaluator.
 *
 * This package implements the two-tier (reject vs redact) forbidden-field
 * policy described in `docs/architecture/01-event-contract.md`. It is the
 * single code-backed source of truth for:
 *
 *   - the platform-default reject list (only `pii_card` / `pii_secret`
 *     named fields)
 *   - the platform-default redact list (the named `card_number` rule plus
 *     five pattern detectors)
 *   - the closed-set reason codes (`pii_card`, `pii_account`, `pii_secret`,
 *     `policy`, `length`, `pattern_match`)
 *   - the deterministic, side-effect-free evaluator the ingester uses
 *     before publishing to RabbitMQ
 *   - the metric helper that emits
 *     `polaris_ingest_redacted_pattern_total{project_id, environment, reason, pattern}`
 *
 * Project overrides live alongside the platform policy at
 * `catalog/policy/forbidden-fields.<project_id>.ts`. The merge logic in
 * this package enforces the documented downgrade rule: project overrides
 * may not weaken a platform reject to a redact without an explicit
 * `documentedExceptions` entry.
 *
 * The package also owns the per-project identity-override contract
 * (`identity.ts`): the `identity:` block of `catalog/projects/<id>.yaml`,
 * shared by the CLI's catalog validation and the identity stage's boot
 * loader so the two cannot drift.
 */

export { applyRedactions, evaluate, redactionSentinel } from "./evaluator.js";
export {
  type IdentityOverrideKind,
  type ProjectEnrichmentOverride,
  projectEnrichmentOverrideSchema,
  type ProjectIdentityOverride,
  projectIdentityOverrideSchema,
} from "./project-overrides.js";
export {
  formatPolicyInspection,
  inspectPolicy,
  type PolicyInspection,
} from "./inspect.js";
export { type MergeResult, mergePolicy, PolicyMergeError } from "./merge.js";
export {
  emitAllRedactionMetrics,
  emitRedactionMetric,
  type PatternRedactionMetricIncrement,
  type PatternRedactionMetricLabels,
  POLARIS_INGEST_REDACTED_PATTERN_TOTAL,
  type RedactionEmissionContext,
  type RedactionEmissionDeps,
} from "./metrics.js";
export {
  AWS_ACCESS_KEY_PATTERN,
  DEFAULT_PATTERN_RULES,
  GITHUB_TOKEN_PATTERN,
  HIGH_ENTROPY_SECRET_PATTERN,
  JWT_PATTERN,
  LUHN_PAN_PATTERN,
} from "./patterns.js";
export { PLATFORM_DEFAULT_POLICY } from "./policy.js";
export {
  isPolicyReasonCode,
  POLICY_BATCH_REASON_FORBIDDEN_FIELD_REJECTED,
  POLICY_REASON_CODES,
  POLICY_REASON_LENGTH,
  POLICY_REASON_PATTERN_MATCH,
  POLICY_REASON_PII_ACCOUNT,
  POLICY_REASON_PII_CARD,
  POLICY_REASON_PII_SECRET,
  POLICY_REASON_POLICY,
  type PolicyReasonCode,
} from "./reason-codes.js";
export type {
  AcceptDecision,
  EvaluateOptions,
  EventInput,
  ForbiddenFieldPolicy,
  NamedFieldRule,
  PatternRule,
  PolicyDecision,
  PolicyExceptionNote,
  ProjectPolicyOverride,
  RedactionAction,
  RejectDecision,
} from "./types.js";
