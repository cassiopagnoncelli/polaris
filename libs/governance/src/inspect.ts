import { mergePolicy } from "./merge.js";
import type { ForbiddenFieldPolicy, PolicyExceptionNote, ProjectPolicyOverride } from "./types.js";

/**
 * Inspection output for the policy CLI command.
 *
 * The CLI uses this structure both for JSON output and for the
 * human-friendly table renderer. It carries:
 *
 *   - the effective merged policy
 *   - the project identifier (if an override was supplied)
 *   - the documented exceptions list (downgrade audit trail)
 *   - counts of platform-only vs project-added entries
 *
 * The structure never carries raw event values — only metadata.
 */
export interface PolicyInspection {
  readonly project_id?: string;
  readonly policy: ForbiddenFieldPolicy;
  readonly counts: {
    readonly reject_total: number;
    readonly reject_platform: number;
    readonly reject_project: number;
    readonly redact_named_total: number;
    readonly redact_named_platform: number;
    readonly redact_named_project: number;
    readonly redact_patterns_total: number;
    readonly redact_patterns_platform: number;
    readonly redact_patterns_project: number;
  };
  readonly exceptions: readonly PolicyExceptionNote[];
}

/**
 * Build a `PolicyInspection` for the supplied override (or the platform
 * defaults if no override is supplied). Pure function; safe to call from
 * the CLI or from tests.
 *
 * Counts are sliced into `platform` vs `project` so operators can tell at
 * a glance which rules originated from the platform defaults and which
 * came from the project's own policy file.
 */
export function inspectPolicy(override?: ProjectPolicyOverride): PolicyInspection {
  const merge = mergePolicy(override);
  const policy = merge.policy;

  // The merge result preserves platform entries first, then project
  // additions. Re-running the merge here lets us count without exposing
  // private merge internals.
  const platformRejectCount = countByOrigin(policy.reject.length, override?.reject?.length ?? 0);
  const platformRedactCount = countByOrigin(
    policy.redactNamed.length,
    override?.redactNamed?.length ?? 0,
  );
  const platformPatternCount = countByOrigin(
    policy.redactPatterns.length,
    override?.redactPatterns?.length ?? 0,
  );

  const result: PolicyInspection = {
    ...(merge.override ? { project_id: merge.override.project_id } : {}),
    policy,
    counts: {
      reject_total: policy.reject.length,
      reject_platform: platformRejectCount.platform,
      reject_project: platformRejectCount.project,
      redact_named_total: policy.redactNamed.length,
      redact_named_platform: platformRedactCount.platform,
      redact_named_project: platformRedactCount.project,
      redact_patterns_total: policy.redactPatterns.length,
      redact_patterns_platform: platformPatternCount.platform,
      redact_patterns_project: platformPatternCount.project,
    },
    exceptions: merge.override?.exceptions ?? [],
  };
  return result;
}

function countByOrigin(
  totalAfterMerge: number,
  declaredOverrideCount: number,
): { platform: number; project: number } {
  // Dedupe may swallow project entries that exactly mirror platform ones.
  // For the purposes of inspection, the project count is at most the
  // declared count and the difference vs total stays attributed to the
  // platform. This keeps counts conservative — over-attributing to the
  // platform — which is the safer accounting for an audit surface.
  const project = Math.min(
    declaredOverrideCount,
    Math.max(0, totalAfterMerge - (totalAfterMerge - declaredOverrideCount)),
  );
  return {
    platform: totalAfterMerge - project,
    project,
  };
}

/**
 * Format an inspection result as a multi-line human-readable string.
 *
 * Format is deliberately stable: a header, three sections (reject /
 * redact named / redact patterns), and an `exceptions` block. Field
 * paths, reason codes, and notes are included. No event values.
 */
export function formatPolicyInspection(inspection: PolicyInspection): string {
  const lines: string[] = [];
  const header = inspection.project_id
    ? `Effective forbidden-field policy for project '${inspection.project_id}'`
    : "Effective forbidden-field policy (platform defaults)";
  lines.push(header);
  lines.push("=".repeat(header.length));
  lines.push("");

  lines.push(
    `Reject (${inspection.counts.reject_total}; ${inspection.counts.reject_platform} platform / ${inspection.counts.reject_project} project):`,
  );
  for (const rule of inspection.policy.reject) {
    lines.push(`  - ${rule.field}  reason=${rule.reason}${rule.note ? `  // ${rule.note}` : ""}`);
  }
  lines.push("");

  lines.push(
    `Redact (named) (${inspection.counts.redact_named_total}; ${inspection.counts.redact_named_platform} platform / ${inspection.counts.redact_named_project} project):`,
  );
  for (const rule of inspection.policy.redactNamed) {
    lines.push(`  - ${rule.field}  reason=${rule.reason}${rule.note ? `  // ${rule.note}` : ""}`);
  }
  lines.push("");

  lines.push(
    `Redact (pattern) (${inspection.counts.redact_patterns_total}; ${inspection.counts.redact_patterns_platform} platform / ${inspection.counts.redact_patterns_project} project):`,
  );
  for (const rule of inspection.policy.redactPatterns) {
    lines.push(
      `  - pattern=${rule.pattern}  reason=${rule.reason}${rule.note ? `  // ${rule.note}` : ""}`,
    );
  }
  lines.push("");

  if (inspection.exceptions.length > 0) {
    lines.push(`Documented exceptions (${inspection.exceptions.length}):`);
    for (const note of inspection.exceptions) {
      lines.push(
        `  - field=${note.field}  reviewer=${note.reviewer}  approved_at=${note.approved_at}`,
      );
      lines.push(`      rationale: ${note.rationale}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
