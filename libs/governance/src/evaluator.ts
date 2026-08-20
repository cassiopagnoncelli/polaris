import { mergePolicy } from "./merge.js";
import type {
  EvaluateOptions,
  EventInput,
  NamedFieldRule,
  PatternRule,
  PolicyDecision,
  ProjectPolicyOverride,
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
// The quarantine's redacted sample
// ---------------------------------------------------------------------------

/**
 * The second walk. `evaluate` above walks to DECIDE and short-circuits at
 * the first reject; this one walks to REDACT a rejected payload for the
 * schema-governance quarantine, and cannot short-circuit — the reject is
 * why it is walking.
 *
 * They live in one file because they share the rules, and a brief life as
 * two files proved the point: the sample builder grew its own matcher that
 * read `rule.fields` as an array and `rule.pattern` as a regex, when the
 * real shapes are a single `field` string with `*.`/`[*]` wildcards and a
 * `test(value, path)` predicate. Nothing type-checked it, because the
 * duplicate declared its own view of the types — and what it would have
 * shipped is a sample that stores exactly what the rules exist to keep out.
 */

/** Longest string leaf kept in a sample before truncation. */
const DEFAULT_SAMPLE_MAX_STRING = 128;

/** Deepest nesting kept in a sample. Below it, a marker replaces the value. */
const DEFAULT_SAMPLE_MAX_DEPTH = 8;

/** Most array elements kept per array. */
const DEFAULT_SAMPLE_MAX_ARRAY = 20;

/** Most object keys kept per object. */
const DEFAULT_SAMPLE_MAX_KEYS = 50;

/** Marker written where a value was dropped for being too deep or too many. */
/**
 * Marker written where a value was dropped for being too deep or too many.
 * Not exported: readers match the literal, and a constant nothing outside
 * this package reads is a constant pretending to be an interface.
 */
const SAMPLE_ELIDED = "[ELIDED]" as const;

export interface ViolationSampleOptions {
  /** Project override, merged with the platform defaults as usual. */
  readonly projectPolicy?: ProjectPolicyOverride;
  readonly maxStringLength?: number;
  readonly maxDepth?: number;
  readonly maxArrayLength?: number;
  readonly maxKeys?: number;
}

export interface ViolationSample {
  /** The redacted structure, safe to persist. */
  readonly sample: Record<string, unknown>;
  /**
   * Dotted paths of every value the sample replaced with a sentinel.
   *
   * Paths only, never values — this is the same discipline the batch
   * response follows, and it is what makes the quarantine searchable
   * ("which projects are still sending `card_number`?") without making it
   * a second copy of the data it exists to keep out.
   */
  readonly redactedPaths: readonly string[];
}

/**
 * Build the sample stored on a violation record.
 *
 * Deterministic and non-mutating. The returned object shares no structure
 * with the input.
 */
export function buildViolationSample(
  event: EventInput,
  options: ViolationSampleOptions = {},
): ViolationSample {
  const policy = mergePolicy(options.projectPolicy).policy;
  const maxStringLength = options.maxStringLength ?? DEFAULT_SAMPLE_MAX_STRING;
  const maxDepth = options.maxDepth ?? DEFAULT_SAMPLE_MAX_DEPTH;
  const maxArrayLength = options.maxArrayLength ?? DEFAULT_SAMPLE_MAX_ARRAY;
  const maxKeys = options.maxKeys ?? DEFAULT_SAMPLE_MAX_KEYS;

  const redactedPaths: string[] = [];

  function walk(value: unknown, path: readonly string[], depth: number): unknown {
    if (depth > maxDepth) return SAMPLE_ELIDED;

    if (Array.isArray(value)) {
      const kept = value.slice(0, maxArrayLength);
      const out: unknown[] = kept.map((item, index) =>
        walk(item, [...path, String(index)], depth + 1),
      );
      if (value.length > kept.length) out.push(SAMPLE_ELIDED);
      return out;
    }

    if (isPlainRecord(value)) {
      const out: Record<string, unknown> = {};
      let seen = 0;
      for (const [key, child] of Object.entries(value)) {
        if (seen >= maxKeys) {
          out[SAMPLE_ELIDED] = `${String(Object.keys(value).length - seen)} more key(s)`;
          break;
        }
        seen += 1;
        const childPath = [...path, key];

        // A reject rule is the strongest signal there is: this field is
        // why the event was refused. The KEY stays — that is the whole
        // diagnostic — and the value never does.
        const rejectHit = matchNamedRule(policy.reject, childPath);
        if (rejectHit !== undefined) {
          out[key] = redactionSentinel(rejectHit.reason);
          redactedPaths.push(childPath.join("."));
          continue;
        }

        const namedHit = matchNamedRule(policy.redactNamed, childPath);
        if (namedHit !== undefined) {
          // Replaces the whole subtree, as on the accept path. Descending
          // would be wasted work and could surface false-positive pattern
          // hits inside a value already known to be sensitive.
          out[key] = redactionSentinel(namedHit.reason);
          redactedPaths.push(childPath.join("."));
          continue;
        }

        out[key] = walk(child, childPath, depth + 1);
      }
      return out;
    }

    if (typeof value === "string") {
      const patternHit = matchPatternRule(policy.redactPatterns, value, path);
      if (patternHit !== undefined) {
        redactedPaths.push(path.join("."));
        return redactionSentinel(patternHit.reason);
      }
      return truncate(value, maxStringLength);
    }

    // Numbers, booleans, null. Kept as-is: they are the shape information
    // a producer needs ("total came through as a string") and carry no
    // free text.
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;

    // Anything exotic a producer smuggled in — a Date, a class instance.
    // Named by type rather than serialised, because `toJSON` on an unknown
    // object is arbitrary code's idea of what to disclose.
    return `[${typeof value}]`;
  }

  const walked = walk(event, [], 0);
  const sample = isPlainRecord(walked) ? walked : {};
  return { sample, redactedPaths };
}

/**
 * Serialise a sample, capping the encoded size.
 *
 * The structural bounds above limit breadth and depth but not total size —
 * fifty keys of a hundred-character string each is still 5KB, and a
 * quarantine table is not a place to store payloads. Over the cap the
 * sample is replaced wholesale rather than truncated mid-string, because a
 * truncated JSON document is not JSON and every reader would have to
 * special-case it.
 */
export function serialiseViolationSample(
  sample: Record<string, unknown>,
  maxBytes = 8_192,
): string {
  const encoded = JSON.stringify(sample);
  if (Buffer.byteLength(encoded, "utf8") <= maxBytes) return encoded;
  return JSON.stringify({
    [SAMPLE_ELIDED]: `sample exceeded ${String(maxBytes)} bytes and was dropped`,
    keys: Object.keys(sample).slice(0, DEFAULT_SAMPLE_MAX_KEYS),
  });
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…(+${String(value.length - max)})`;
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
