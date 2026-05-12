import type { PolicyReasonCode } from "./reason-codes.js";

/**
 * Public types for the forbidden-field policy.
 *
 * The policy is a code-backed file (`catalog/policy/forbidden-fields.ts`)
 * that declares two lists:
 *
 *   - **reject list** — named fields whose mere presence rejects the event
 *   - **redact list** — named fields and pattern-based detections whose
 *     value is replaced with `[REDACTED:<reason>]` while the event continues
 *
 * The evaluator (see `evaluator.ts`) walks an event envelope, applies the
 * reject and redact rules, and returns a deterministic decision. The
 * caller is responsible for actually applying the redactions to a cloned
 * event before forwarding it downstream — the evaluator itself does not
 * mutate input.
 *
 * Project overrides live at `catalog/policy/forbidden-fields.<project_id>.ts`
 * and may only:
 *
 *   - add fields to either list
 *   - add pattern-based redactions
 *   - **not** downgrade a platform reject to a redact, and **not** remove a
 *     platform reject entry, except with a documented exception note in the
 *     override file
 *
 * @see docs/architecture/01-event-contract.md "Forbidden-Field Policy"
 */

/**
 * A named-field rule: a field name (or dotted path glob) that triggers a
 * reject or redact decision when present in an event.
 *
 * Matching is case-insensitive on the final segment so a producer using
 * `Password` vs `password` cannot bypass a rule. Path matching also accepts
 * a leading `*.` to match anywhere in the envelope, or a fully-qualified
 * dotted path to scope the rule to a specific location (e.g.
 * `properties.payment.cvv`).
 *
 * `value` matchers are intentionally **not** part of named-field rules —
 * named matches fire on key presence, not value content. Value-content
 * matchers live in `PatternRule`.
 */
export interface NamedFieldRule {
  /**
   * Field name to match. May be:
   *
   *   - a bare segment name (e.g. `cvv`) — matches that key at any depth
   *   - a leading-wildcard path (e.g. `*.cvv`) — equivalent shorthand for
   *     "any depth"
   *   - a fully-qualified dotted path (e.g. `properties.payment.cvv`) —
   *     matches only at that exact location
   *
   * Matching is case-insensitive on each segment.
   */
  readonly field: string;
  /** Closed-set reason code emitted when the rule fires. */
  readonly reason: PolicyReasonCode;
  /**
   * Optional human-readable note carried alongside the rule for
   * documentation / CLI inspection. Never logged with values.
   */
  readonly note?: string;
}

/**
 * A pattern-based redaction rule.
 *
 * Pattern rules match against string values, not field names. They fire on
 * the value contents of any string field in the event (subject to the
 * optional `excludePathPrefixes` filter, used to keep JWT-shaped tokens in
 * `identity.*` from triggering a redaction).
 *
 * Pattern rules are **never** on the reject list. They always redact and
 * always emit the `polaris_ingest_redacted_pattern_total` metric.
 */
export interface PatternRule {
  /**
   * Stable identifier used as the `pattern` label on the metric. Must be a
   * snake_case tag scoped to its detector (e.g. `luhn_pan`, `aws_access_key`,
   * `github_token`, `jwt`, `high_entropy_secret`).
   */
  readonly pattern: string;
  /** Closed-set reason code emitted when the pattern fires. */
  readonly reason: PolicyReasonCode;
  /**
   * Detector predicate. Receives the candidate string value plus the field
   * path the value was found at (so the predicate can decline by path —
   * e.g. JWT shapes inside `identity.*`).
   *
   * Returning `true` redacts the value. The detector receives the path as
   * an array of strings (not the raw value) for label clarity; it must not
   * log either argument.
   */
  readonly test: (value: string, path: readonly string[]) => boolean;
  /**
   * Optional explanatory note for CLI inspection. Never logged with values.
   */
  readonly note?: string;
}

/**
 * A merged forbidden-field policy.
 *
 * Composed by combining the platform defaults with an optional project
 * override file. The merge is performed by `mergePolicy()`; consumers
 * normally do not construct this object directly.
 */
export interface ForbiddenFieldPolicy {
  /** Named-field rules whose presence rejects the event. */
  readonly reject: readonly NamedFieldRule[];
  /** Named-field rules whose value is replaced with the redaction sentinel. */
  readonly redactNamed: readonly NamedFieldRule[];
  /** Pattern-based redaction rules (always emit the metric). */
  readonly redactPatterns: readonly PatternRule[];
}

/**
 * A draft project-override policy. The same shape as `ForbiddenFieldPolicy`
 * but carries the `project_id` identifier and the optional
 * `documentedExceptions` array used to allow narrow downgrades during
 * merge.
 *
 * The override file is expected to default-export this shape, e.g.:
 *
 * ```ts
 * import type { ProjectPolicyOverride } from "@polaris/shared-policy";
 * const override: ProjectPolicyOverride = { project_id: "checkout", ... };
 * export default override;
 * ```
 */
export interface ProjectPolicyOverride {
  /** Project identifier scope. Must match the project's `project_id`. */
  readonly project_id: string;
  /** Additional named-field reject rules. */
  readonly reject?: readonly NamedFieldRule[];
  /** Additional named-field redact rules. */
  readonly redactNamed?: readonly NamedFieldRule[];
  /** Additional pattern-based redactions. */
  readonly redactPatterns?: readonly PatternRule[];
  /**
   * Explicit downgrade exceptions. The merger refuses to weaken any
   * platform reject entry unless the entry is named here with rationale.
   * Each entry documents the field, the reviewer, and the rationale; the
   * inspector exposes the list so reviewers can audit it.
   */
  readonly documentedExceptions?: readonly PolicyExceptionNote[];
}

/**
 * Documented exception note. Required to downgrade a platform reject entry
 * to a redact in a project override.
 */
export interface PolicyExceptionNote {
  /** The platform reject field path being downgraded. */
  readonly field: string;
  /** Free-form rationale. */
  readonly rationale: string;
  /** Reviewer identifier or PR reference. */
  readonly reviewer: string;
  /** ISO 8601 UTC timestamp of the exception. */
  readonly approved_at: string;
}

/**
 * An individual redaction operation produced by the evaluator. The caller
 * applies these to a cloned event before forwarding.
 */
export interface RedactionAction {
  /** Dotted path of the field to redact. */
  readonly path: readonly string[];
  /** Reason code recorded alongside the redaction. */
  readonly reason: PolicyReasonCode;
  /**
   * Pattern tag — present only for pattern-based redactions. Used as the
   * `pattern` metric label.
   */
  readonly pattern?: string;
  /**
   * Source of the rule that fired:
   *
   *   - `named`   — a named-field rule (platform or project)
   *   - `pattern` — a pattern-based detector
   */
  readonly source: "named" | "pattern";
  /**
   * Replacement value to write at `path`. Stable sentinel of the form
   * `[REDACTED:<reason>]`.
   */
  readonly replacement: string;
}

/**
 * A reject decision produced by the evaluator. Carries the field path
 * that triggered the rejection (so the ingester can surface it in the
 * batch response) plus the closed-set reason code. The raw value of the
 * rejecting field is never carried in this structure.
 */
export interface RejectDecision {
  readonly decision: "reject";
  /** Dotted path of the field whose presence triggered the rejection. */
  readonly path: readonly string[];
  /** Closed-set reason code for the rejection. */
  readonly reason: PolicyReasonCode;
}

/** An accept (possibly with redactions) decision produced by the evaluator. */
export interface AcceptDecision {
  readonly decision: "accept";
  readonly redactions: readonly RedactionAction[];
}

export type PolicyDecision = AcceptDecision | RejectDecision;

/**
 * Minimal subset of the canonical envelope the evaluator needs. The
 * envelope schema in `@polaris/shared-schemas` declares the authoritative
 * shape; here we accept any object-shaped event so the evaluator can run
 * before envelope validation completes.
 */
export type EventInput = Readonly<Record<string, unknown>>;

/** Options accepted by `evaluate()`. */
export interface EvaluateOptions {
  /** Project policy override (already loaded). Optional. */
  readonly projectPolicy?: ProjectPolicyOverride;
  /**
   * Maximum recursion depth for nested objects/arrays. Default: 64. The
   * envelope itself never reaches anywhere near this; the cap exists to
   * guard against pathological producer payloads.
   */
  readonly maxDepth?: number;
}
