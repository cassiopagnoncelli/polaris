/**
 * Pure identifier extraction for the identity stage.
 *
 * Everything here is a function of the inbound envelope and the resolved
 * policy — no I/O, no clock, no database. The transaction in
 * `runtime.ts` does the stateful work; keeping the decision of WHICH
 * identifiers count separate from WHAT to do with them is what makes the
 * denylist and the cap testable without a Postgres.
 */

/** Identifier kinds the stage binds in v1. */
export const STRONG_IDENTITY_KINDS = ["customer_id", "anonymous_id"] as const;
export type StrongIdentityKind = (typeof STRONG_IDENTITY_KINDS)[number];

/**
 * `session_id` and `device_id` are deliberately NOT bound.
 *
 * `session_id` rotates every 30 minutes, so binding it would attach a
 * new identifier to the profile several times a day — straight into the
 * per-kind cap for no resolution value. `device_id` is always null in
 * both SDKs today; binding a field nothing populates would be dead code
 * that looks like a feature. Both are reserved in `profile_identifiers`
 * (its `kind` column is open text) for when that changes.
 */
export const RESERVED_IDENTITY_KINDS = ["session_id", "device_id"] as const;

/** One identifier the stage will attempt to bind. */
export interface CollectedIdentifier {
  readonly kind: StrongIdentityKind;
  readonly value: string;
}

/** Why an identifier present on the envelope was not collected. */
export type SkipReason = "absent" | "denylisted";

export interface CollectOutcome {
  /** Identifiers to resolve, in canonical (kind, value) order. */
  readonly identifiers: readonly CollectedIdentifier[];
  /** Identifiers present on the envelope but refused by the denylist. */
  readonly denylisted: readonly CollectedIdentifier[];
}

/**
 * Policy resolved for one project/environment.
 *
 * `denylist` holds identifier VALUES that resolve as if absent — kiosk
 * device ids, `customer_id: "guest"`, a bot's shared anonymous id. These
 * are the values that, left alone, chain-merge thousands of profiles
 * into one; refusing them at collection time is cheaper and far easier
 * to reason about than unwinding the merge afterwards.
 */
export interface IdentityPolicy {
  /** Denylisted values, keyed by identifier kind. */
  readonly denylist: Readonly<Partial<Record<StrongIdentityKind, ReadonlySet<string>>>>;
  readonly maxIdentifiersPerKind: number;
  readonly maxMergesPerWindow: number;
  readonly mergeWindowSeconds: number;
  readonly maxTraitsBytes: number;
}

/** Minimal envelope shape this stage reads. */
export interface IdentityStageEvent {
  readonly event: string;
  readonly identity?: {
    readonly customer_id?: string | null;
    readonly anonymous_id?: string | null;
    readonly session_id?: string | null;
    readonly device_id?: string | null;
  };
  readonly properties?: Record<string, unknown>;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Collect the strong identifiers to resolve, in a canonical order.
 *
 * Ordering is not cosmetic: the transaction locks identifier rows in the
 * order returned here, and a consistent order across every worker is
 * what prevents two events touching the same pair of identifiers from
 * deadlocking each other.
 */
export function collectIdentifiers(
  event: IdentityStageEvent,
  policy: IdentityPolicy,
): CollectOutcome {
  const identifiers: CollectedIdentifier[] = [];
  const denylisted: CollectedIdentifier[] = [];

  for (const kind of [...STRONG_IDENTITY_KINDS].sort()) {
    const value = nonEmpty(event.identity?.[kind]);
    if (value === undefined) continue;
    if (policy.denylist[kind]?.has(value) === true) {
      denylisted.push({ kind, value });
      continue;
    }
    identifiers.push({ kind, value });
  }

  identifiers.sort((a, b) =>
    a.kind === b.kind ? compare(a.value, b.value) : compare(a.kind, b.kind),
  );
  return { identifiers, denylisted };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Identify-family events are the only ones whose properties may patch
 * profile traits.
 *
 * Restricting the writer set is what keeps last-write-wins explainable:
 * all events for a given customer serialize on one partition, so a
 * single serialized writer per person means the final trait value is a
 * function of arrival order and nothing else. Letting any `track()` push
 * traits would reintroduce the ambiguity from several directions at once.
 */
export const IDENTIFY_FAMILY_EVENTS = ["user.identified"] as const;

export function isIdentifyFamily(event: IdentityStageEvent): boolean {
  return (IDENTIFY_FAMILY_EVENTS as readonly string[]).includes(event.event);
}

/**
 * Traits to merge-patch from an identify-family event.
 *
 * Returns `null` when the snapshot exceeds the size guard: the event
 * still resolves and still binds identifiers, it just does not carry its
 * traits into the store. Dropping the event instead would lose an
 * identity link over a payload-size problem.
 */
export function extractTraits(
  event: IdentityStageEvent,
  policy: IdentityPolicy,
): { readonly traits: Record<string, unknown> | null; readonly overCap: boolean } {
  if (!isIdentifyFamily(event)) return { traits: null, overCap: false };
  const properties = event.properties ?? {};
  if (Object.keys(properties).length === 0) return { traits: null, overCap: false };

  const encoded = Buffer.byteLength(JSON.stringify(properties), "utf8");
  if (encoded > policy.maxTraitsBytes) {
    return { traits: null, overCap: true };
  }
  return { traits: { ...properties }, overCap: false };
}
