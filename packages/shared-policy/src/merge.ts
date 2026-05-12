import { PLATFORM_DEFAULT_POLICY } from "./policy.js";
import type {
  ForbiddenFieldPolicy,
  NamedFieldRule,
  PolicyExceptionNote,
  ProjectPolicyOverride,
} from "./types.js";

/**
 * Merge the platform-default policy with a project override.
 *
 * Merge rules per `docs/architecture/01-event-contract.md` "Project overrides":
 *
 *   - Override may **add** entries to the reject list.
 *   - Override may **add** entries to the redact list.
 *   - Override may **add** pattern-based detections.
 *   - Override may **not** remove a platform reject entry.
 *   - Override may **not** downgrade a platform reject entry to a redact
 *     unless a `documentedExceptions` entry names the field, the reviewer,
 *     and the rationale.
 *
 * The merger throws a `PolicyMergeError` when a downgrade attempt is
 * detected without the matching exception. The error names the offending
 * field and reviewer fields so the failing build / startup log can
 * surface the violation. Values never appear in the error message.
 */
export class PolicyMergeError extends Error {
  override readonly name = "PolicyMergeError";
  constructor(message: string) {
    super(message);
  }
}

export interface MergeResult {
  /** The composed policy. */
  readonly policy: ForbiddenFieldPolicy;
  /** Project override metadata, present only when an override was supplied. */
  readonly override?: {
    readonly project_id: string;
    readonly exceptions: readonly PolicyExceptionNote[];
  };
}

/**
 * Merge `PLATFORM_DEFAULT_POLICY` with an optional project override.
 *
 * Deduplicates rules by `(field, reason)` so a project that re-states a
 * platform rule does not produce duplicate entries. Pattern rules
 * deduplicate by `pattern` tag.
 */
export function mergePolicy(override?: ProjectPolicyOverride): MergeResult {
  if (!override) {
    return { policy: PLATFORM_DEFAULT_POLICY };
  }

  const exceptions = override.documentedExceptions ?? [];
  const exceptionByField = new Map<string, PolicyExceptionNote>();
  for (const note of exceptions) {
    exceptionByField.set(normaliseFieldKey(note.field), note);
  }

  // Validate: no override entry on the redact list may share a field path
  // with a platform reject entry unless a documented exception covers it.
  if (override.redactNamed) {
    for (const rule of override.redactNamed) {
      const key = normaliseFieldKey(rule.field);
      const platformReject = PLATFORM_DEFAULT_POLICY.reject.find(
        (entry) => normaliseFieldKey(entry.field) === key,
      );
      if (platformReject && !exceptionByField.has(key)) {
        throw new PolicyMergeError(
          `project '${override.project_id}' attempted to downgrade platform reject field '${rule.field}' to redact without a documentedExceptions entry`,
        );
      }
    }
  }

  // Reject overrides may add new entries but may not remove platform
  // entries. There is no override mechanism to drop a platform reject;
  // any documented exception only permits downgrading (handled above).
  const reject = dedupeNamedRules([...PLATFORM_DEFAULT_POLICY.reject, ...(override.reject ?? [])]);

  // Redact list: platform defaults + override additions, with the
  // downgrade check already enforced above.
  const redactNamed = dedupeNamedRules([
    ...PLATFORM_DEFAULT_POLICY.redactNamed,
    ...(override.redactNamed ?? []),
  ]);

  // Pattern rules: platform defaults always retained; project may append.
  const seenPatterns = new Set<string>();
  const redactPatterns: typeof PLATFORM_DEFAULT_POLICY.redactPatterns = [
    ...PLATFORM_DEFAULT_POLICY.redactPatterns,
    ...(override.redactPatterns ?? []),
  ].filter((rule) => {
    if (seenPatterns.has(rule.pattern)) return false;
    seenPatterns.add(rule.pattern);
    return true;
  });

  return {
    policy: Object.freeze({ reject, redactNamed, redactPatterns }),
    override: {
      project_id: override.project_id,
      exceptions,
    },
  };
}

/**
 * Stable lookup key for a named-field rule. Lowercased so case-only
 * differences between rules collapse on dedupe.
 */
function normaliseFieldKey(field: string): string {
  return field.toLowerCase();
}

/**
 * De-duplicate a named-rule list, keeping the first occurrence per
 * `(field, reason)` tuple. Platform rules come first in the merge order
 * so their notes survive; project additions for distinct reason codes
 * are preserved.
 */
function dedupeNamedRules(rules: readonly NamedFieldRule[]): readonly NamedFieldRule[] {
  const seen = new Set<string>();
  const out: NamedFieldRule[] = [];
  for (const rule of rules) {
    const key = `${normaliseFieldKey(rule.field)}|${rule.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rule);
  }
  return out;
}
