import { mergePolicy } from "./merge.js";
import type {
  EvaluateOptions,
  EventInput,
  NamedFieldRule,
  PatternRule,
  PolicyDecision,
  RedactionAction,
} from "./types.js";

/**
 * Evaluate an event against the forbidden-field policy.
 *
 * The evaluator is **deterministic**, **does not mutate the input event**,
 * and **never logs raw values**. It walks the event structure once,
 * applies the merged policy, and returns a decision. Callers that receive
 * `decision: 'accept'` with non-empty `redactions` are responsible for
 * applying those redactions to a cloned event before forwarding.
 *
 * Order of operations within the walk:
 *
 *   1. At each visited field path, check named-field reject rules. The
 *      first reject match returns immediately with `decision: 'reject'`.
 *   2. If no reject rule matched, check named-field redact rules. A match
 *      records a redaction action; the walk continues into the field
 *      value only if the value is itself a container, but does not apply
 *      pattern detection to the original string value (the redaction
 *      sentinel replaces it).
 *   3. If neither named rule matched and the value is a string, apply
 *      pattern detectors in order. The first match wins.
 *   4. Containers (objects, arrays) are recursed.
 *
 * The walk has a depth cap (`maxDepth`, default 64) to bound work on
 * pathological producer payloads.
 */
export function evaluate(event: EventInput, options: EvaluateOptions = {}): PolicyDecision {
  const merge = mergePolicy(options.projectPolicy);
  const policy = merge.policy;
  const maxDepth = options.maxDepth ?? 64;

  const redactions: RedactionAction[] = [];

  // The walk uses an explicit stack rather than recursion to avoid a deep
  // call stack on adversarial payloads. Each frame carries the value, the
  // path, and the current depth.
  type Frame = { value: unknown; path: string[]; depth: number };
  const stack: Frame[] = [{ value: event, path: [], depth: 0 }];

  let rejection: PolicyDecision | null = null;

  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;
    const { value, path, depth } = frame;

    if (depth > maxDepth) continue;

    // ---- containers ---------------------------------------------------
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) {
        stack.push({ value: value[i], path: [...path, String(i)], depth: depth + 1 });
      }
      continue;
    }
    if (isPlainRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        const childPath = [...path, key];

        // Check reject rules on the child key first. A reject match short
        // circuits the entire walk.
        const rejectHit = matchNamedRule(policy.reject, childPath);
        if (rejectHit) {
          rejection = {
            decision: "reject",
            path: childPath,
            reason: rejectHit.reason,
          };
          break;
        }

        // Then check redact-named rules. A named-redact match short
        // circuits descent into that child — the redaction sentinel
        // replaces the entire subtree, so descending would be wasted
        // work and could surface false-positive pattern hits.
        const redactNamedHit = matchNamedRule(policy.redactNamed, childPath);
        if (redactNamedHit) {
          redactions.push({
            path: childPath,
            reason: redactNamedHit.reason,
            source: "named",
            replacement: redactionSentinel(redactNamedHit.reason),
          });
          continue;
        }

        // No named match — descend.
        stack.push({ value: child, path: childPath, depth: depth + 1 });
      }
      if (rejection) break;
      continue;
    }

    // ---- leaves -------------------------------------------------------
    if (typeof value === "string" && path.length > 0) {
      const patternHit = matchPatternRule(policy.redactPatterns, value, path);
      if (patternHit) {
        redactions.push({
          path,
          reason: patternHit.reason,
          source: "pattern",
          pattern: patternHit.pattern,
          replacement: redactionSentinel(patternHit.reason),
        });
      }
    }
  }

  if (rejection) return rejection;
  // Sort redactions by path for determinism — stack walk order otherwise
  // depends on object key order, which is engine-defined.
  redactions.sort((a, b) => comparePaths(a.path, b.path));
  return { decision: "accept", redactions };
}

/**
 * Apply a list of redaction actions to a cloned event. The original event
 * is untouched. Returns the cloned event with redactions applied; missing
 * intermediate keys are tolerated and left untouched.
 *
 * The clone is a structured-clone-shallow deep copy that preserves arrays
 * and plain objects. Producers that smuggle exotic constructors into the
 * envelope already fail upstream envelope validation; this helper does
 * not attempt to clone exotic prototypes.
 */
export function applyRedactions<T extends EventInput>(
  event: T,
  redactions: readonly RedactionAction[],
): T {
  if (redactions.length === 0) return cloneValue(event) as T;
  const cloned = cloneValue(event) as Record<string, unknown>;
  for (const action of redactions) {
    setAtPath(cloned, action.path, action.replacement);
  }
  return cloned as T;
}

/**
 * Stable sentinel string for a redacted value. Format:
 *   `[REDACTED:<reason>]`
 * The format is part of the contract — downstream consumers (logger,
 * DLQ inspectors, redaction-aware UI) detect redactions by this string.
 */
export function redactionSentinel(reason: string): string {
  return `[REDACTED:${reason}]`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Match a named-rule list against a dotted path. A rule's `field` may be:
 *
 *   - a bare segment ("cvv")           — fires on a leaf segment match
 *   - a leading-wildcard ("*.cvv")     — fires on a leaf segment match
 *   - a fully-qualified path ("a.b.c") — fires only when path matches exactly
 *
 * Matching is case-insensitive on each segment.
 */
function matchNamedRule(
  rules: readonly NamedFieldRule[],
  path: readonly string[],
): NamedFieldRule | undefined {
  if (path.length === 0) return undefined;
  const leaf = path[path.length - 1]?.toLowerCase();
  for (const rule of rules) {
    if (matchesNamedRule(rule.field, leaf, path)) return rule;
  }
  return undefined;
}

function matchesNamedRule(
  ruleField: string,
  leaf: string | undefined,
  path: readonly string[],
): boolean {
  if (leaf === undefined) return false;
  const trimmed = ruleField.startsWith("*.") ? ruleField.slice(2) : ruleField;
  if (!trimmed.includes(".")) {
    return trimmed.toLowerCase() === leaf;
  }
  // Fully-qualified path. Segments must match end-to-end. Numeric segments
  // are allowed to wildcard-match by writing `[*]` in the rule; otherwise
  // segments must match by lowercased equality.
  const ruleSegments = trimmed.split(".");
  if (ruleSegments.length !== path.length) return false;
  for (let i = 0; i < ruleSegments.length; i++) {
    const r = ruleSegments[i];
    const p = path[i];
    if (r === undefined || p === undefined) return false;
    if (r === "*" || r === "[*]") continue;
    if (r.toLowerCase() !== p.toLowerCase()) return false;
  }
  return true;
}

function matchPatternRule(
  rules: readonly PatternRule[],
  value: string,
  path: readonly string[],
): PatternRule | undefined {
  for (const rule of rules) {
    if (rule.test(value, path)) return rule;
  }
  return undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => cloneValue(v));
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = cloneValue(v);
    }
    return out;
  }
  return value;
}

function setAtPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  if (path.length === 0) return;
  let cursor: unknown = target;
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i];
    if (segment === undefined) return;
    if (Array.isArray(cursor)) {
      const idx = Number(segment);
      if (!Number.isInteger(idx)) return;
      cursor = cursor[idx];
    } else if (isPlainRecord(cursor)) {
      cursor = cursor[segment];
    } else {
      return;
    }
    if (cursor === undefined || cursor === null) return;
  }
  const leaf = path[path.length - 1];
  if (leaf === undefined) return;
  if (Array.isArray(cursor)) {
    const idx = Number(leaf);
    if (!Number.isInteger(idx)) return;
    cursor[idx] = value;
  } else if (isPlainRecord(cursor)) {
    cursor[leaf] = value;
  }
}

function comparePaths(a: readonly string[], b: readonly string[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? "";
    const bv = b[i] ?? "";
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return a.length - b.length;
}
