/**
 * Pure transform: raw event → identity-resolver decision.
 *
 * The resolver's hot path applies the explicit-overlap rule from
 * `docs/architecture/05-processors-and-replay.md` § "Identity Resolution":
 *
 *   Canonical merges only happen from authoritative links.
 *   Authoritative links include events that explicitly contain both
 *   identifiers, such as `anonymous_id + customer_id`.
 *
 * This module exports a single function — `resolveIdentityCandidate` — that
 * inspects the inbound canonical envelope and decides whether the event
 * carries a usable authoritative overlap. The function is intentionally
 * pure: no I/O, no clock reads except through a caller-supplied function,
 * no schema validation beyond a tiny structural check. Tests and the
 * future replay executor (P7-003) can drive the same function offline.
 *
 * The resolver layer above this module (the runtime in `./runtime.ts`)
 * takes the candidate, consults / writes the durable `identity_links`
 * table, and emits the appropriate governed event on `identity.events`.
 * That layer owns the database; this layer is purely an envelope reader.
 *
 * v1 is intentionally limited to the explicit-overlap rule. Heuristic
 * detection (session proximity, device continuity, IP/UA proximity) is
 * NOT in v1 and would land as new evidence_type values in a future
 * processor — see the manifest and CHANGELOG for the boundary.
 */

import type { RawEventEnvelope } from "./types.js";

/**
 * Static identity for v1 — held as a frozen literal so call sites cannot
 * mutate it. Exported here so the runtime, bootstrap, tests, and DLQ
 * helpers reference the same constants.
 */
export const PROCESSOR_NAME = "identity-resolver" as const;
export const PROCESSOR_VERSION = "v1" as const;

export const PROCESSOR_IDENTITY = Object.freeze({
  name: PROCESSOR_NAME,
  version: PROCESSOR_VERSION,
}) as { readonly name: typeof PROCESSOR_NAME; readonly version: typeof PROCESSOR_VERSION };

/**
 * Evidence type emitted by v1's explicit-overlap rule. Open-vocabulary on
 * the `identity_links` table so new rules add new values without
 * migrations — see the table comment and the CHANGELOG.
 */
export const EVIDENCE_TYPE_EXPLICIT_OVERLAP = "explicit_overlap" as const;

/**
 * Kinds of identifier the resolver recognises in v1. The canonical
 * envelope's `identity` block defines the same fields; this constant
 * exists so the resolver can iterate the recognised kinds without
 * hard-coding the full envelope shape (and so future kinds can be added
 * by editing this list rather than scattered string literals).
 */
export const IDENTITY_KINDS = ["customer_id", "anonymous_id", "session_id", "device_id"] as const;
export type IdentityKind = (typeof IDENTITY_KINDS)[number];

/**
 * Per the architecture's identity-resolution rule, only **strong**
 * identifiers participate in canonical merges. `session_id` rotates too
 * often (every 30 minutes of inactivity per `10-sdk-standards.md`); the
 * resolver does not promote a session-only co-occurrence into a canonical
 * link. `device_id` is reserved but currently always `null` in the SDKs
 * (see `docs/sdk/identity.md`). Updating this list is an explicit
 * semantic change and would require a new processor version.
 */
export const STRONG_IDENTITY_KINDS: ReadonlyArray<IdentityKind> = ["customer_id", "anonymous_id"];

/**
 * Composite identifier in `<kind>:<value>` form. Mirrors the format
 * persisted in `identity_links.left_identifier` /
 * `identity_links.right_identifier` and emitted in identity.linked /
 * identity.merged / identity.rotated property payloads.
 */
export interface CompositeIdentifier {
  readonly kind: IdentityKind;
  readonly value: string;
}

/** Serialise a `(kind, value)` pair into its canonical wire form. */
export function formatIdentifier(kind: IdentityKind, value: string): string {
  return `${kind}:${value}`;
}

/**
 * Convention: pairs are ordered so the alphabetically-smaller `kind` is
 * placed left. This gives each `(left, right)` tuple exactly one canonical
 * orientation, which keeps the `identity_links` partial unique index on
 * the active tuple effective regardless of which direction the resolver
 * observed first.
 */
export function orderPair(
  a: CompositeIdentifier,
  b: CompositeIdentifier,
): { readonly left: CompositeIdentifier; readonly right: CompositeIdentifier } {
  if (a.kind <= b.kind) return { left: a, right: b };
  return { left: b, right: a };
}

/**
 * Outcome of the pure transform. The runtime branches on `kind`:
 *
 *   - `none`           — the event has no explicit overlap; the resolver
 *                        records nothing and emits nothing.
 *   - `authoritative_overlap`
 *                      — the event carries two strong identifiers in the
 *                        canonical `identity` block. The runtime will
 *                        consult / write `identity_links` and emit one of
 *                        identity.linked / identity.merged / identity.rotated
 *                        depending on the existing graph state.
 *
 * The runtime, not this transform, decides which `identity.*` event name
 * to use — that decision needs the durable link table.
 */
export type ResolveIdentityCandidate =
  | { readonly kind: "none" }
  | {
      readonly kind: "authoritative_overlap";
      /** Left identifier in canonical orientation (alphabetically-smaller kind). */
      readonly left: CompositeIdentifier;
      /** Right identifier in canonical orientation. */
      readonly right: CompositeIdentifier;
    };

/**
 * Inspect the canonical envelope and decide whether it carries an
 * authoritative identity overlap.
 *
 * The function only looks at fields the canonical envelope's `identity`
 * block defines (per `01-event-contract.md` § "Identity"). Other fields —
 * `properties`, `context`, `source` — are intentionally ignored. v1 does
 * not infer identity from arbitrary property fields; that would be a
 * semantic change requiring a new processor version.
 */
export function resolveIdentityCandidate(raw: RawEventEnvelope): ResolveIdentityCandidate {
  const present: CompositeIdentifier[] = [];
  for (const kind of STRONG_IDENTITY_KINDS) {
    const value = readIdentityField(raw, kind);
    if (value !== undefined) {
      present.push({ kind, value });
    }
  }

  if (present.length < 2) {
    return { kind: "none" };
  }

  // v1 only handles `anonymous_id + customer_id`. The check is implicit in
  // STRONG_IDENTITY_KINDS today; if a future version widens the set the
  // explicit guard here will keep the v1 directory unchanged.
  const a = present[0];
  const b = present[1];
  if (a === undefined || b === undefined) {
    return { kind: "none" };
  }
  const { left, right } = orderPair(a, b);
  return { kind: "authoritative_overlap", left, right };
}

function readIdentityField(raw: RawEventEnvelope, kind: IdentityKind): string | undefined {
  const value = (raw.identity as unknown as Record<string, unknown>)[kind];
  if (typeof value !== "string") return undefined;
  if (value.length === 0) return undefined;
  return value;
}
