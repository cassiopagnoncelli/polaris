/**
 * Which identifiers count, and in what order they are taken.
 *
 * Everything here is a function of the inbound envelope and the resolved
 * policy — no I/O, no clock, no database. Deciding WHICH identifiers
 * count is separable from what to do with them, and separating the two
 * is what makes the denylist and the cap testable without a Postgres.
 *
 * This module used to be `sync/identity/resolver/v1/src/transform.ts`.
 * It moved because the answer it gives is version-invariant physics
 * (ADR-0007 law 3): `resolver/v1` is a shell that calls it, and a
 * semantic change here takes a new entrypoint or a major version, never
 * an edit in place — the resolver's replay output is a correctness
 * contract, because unmerge is replay-rebuild.
 */

/**
 * Identifier kinds the platform binds today.
 *
 * `session_id` and `device_id` are deliberately NOT here. `session_id`
 * rotates every 30 minutes, so binding it would attach a new identifier
 * to the profile several times a day — straight into the per-kind cap for
 * no resolution value. `device_id` is always null in both SDKs today;
 * binding a field nothing populates would be dead code that looks like a
 * feature. Both are reserved in `profile_identifiers` (its `kind` column
 * is open text) for when that changes, and adding either here changes
 * emitted events, which makes it a new processor version rather than an
 * edit.
 */
const STRONG_IDENTITY_KINDS = ["customer_id", "anonymous_id"] as const;
export type StrongIdentityKind = (typeof STRONG_IDENTITY_KINDS)[number];

/** One identifier the platform will attempt to bind. */
export interface CollectedIdentifier {
  readonly kind: StrongIdentityKind;
  readonly value: string;
}

export interface CollectOutcome {
  /** Identifiers to resolve, in canonical (kind, value) order. */
  readonly identifiers: readonly CollectedIdentifier[];
  /** Identifiers present on the envelope but refused by the denylist. */
  readonly denylisted: readonly CollectedIdentifier[];
}

/**
 * The minimal envelope shape identity resolution reads.
 *
 * Structural rather than the canonical envelope type: the transport
 * hands the stage a `Record<string, unknown>`, and the ingester — not
 * this library — is authoritative on envelope validity.
 */
export interface IdentityEnvelope {
  readonly event: string;
  readonly identity?: {
    readonly customer_id?: string | null;
    readonly anonymous_id?: string | null;
    readonly session_id?: string | null;
    readonly device_id?: string | null;
  };
  readonly properties?: Record<string, unknown>;
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

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Collect the strong identifiers to resolve, in a canonical order.
 *
 * Ordering is not cosmetic: the resolution transaction locks identifier
 * rows in the order returned here, and a consistent order across every
 * worker is what prevents two events touching the same pair of
 * identifiers from deadlocking each other.
 */
export function collectIdentifiers(
  event: IdentityEnvelope,
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
