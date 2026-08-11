/**
 * Pure transform helpers for sessionizer v1.
 *
 * The sessionizer's hot path:
 *
 *   1. Resolve the primary identifier from the canonical envelope's
 *      `identity` block (preference order: customer_id > anonymous_id >
 *      session_id). Events with no usable identifier are dropped.
 *
 *   2. Consult the session store for an active window keyed
 *      on `(project_id, environment, primary_identifier_kind:value)`.
 *
 *   3. Decide between three actions: open a new session, continue an
 *      existing one (no emission), or close-and-reopen on inactivity.
 *
 * The functions in this module are intentionally pure (no I/O, no
 * Date.now) so the runtime can drive them with deterministic clocks in
 * tests and the future replay executor can reuse them offline.
 *
 * Static processor identity is also exported here so the runtime,
 * bootstrap, tests, and DLQ helpers reference the same constants.
 */

import { createHash } from "node:crypto";

import type { RawEventEnvelope, RawEventIdentity } from "./types.js";

/**
 * Static identity for v1 — held as a frozen literal so call sites cannot
 * mutate it.
 */
export const PROCESSOR_NAME = "sessionizer" as const;
export const PROCESSOR_VERSION = "v1" as const;

export const PROCESSOR_IDENTITY = Object.freeze({
  name: PROCESSOR_NAME,
  version: PROCESSOR_VERSION,
}) as { readonly name: typeof PROCESSOR_NAME; readonly version: typeof PROCESSOR_VERSION };

/**
 * Default inactivity window — 30 minutes. Mirrors the Web SDK rotation
 * rule from `docs/architecture/10-sdk-standards.md` and is duplicated as
 * `defaults.session_inactivity_seconds` in `processor.manifest.yaml`.
 * Changing this value is a SEMANTIC change: emitted session events
 * would differ. A bump requires a new processor version.
 */
export const DEFAULT_INACTIVITY_SECONDS = 1800 as const;

/**
 * Kinds of identifier the sessionizer recognises in v1, in PREFERENCE
 * ORDER. The first kind that has a non-empty string value on the
 * envelope's `identity` block is chosen as the primary identifier.
 *
 * Order rationale (per `docs/architecture/05-processors-and-replay.md`
 * "Identity Resolution" and the SDK standards):
 *
 *   - `customer_id` is stable across SDK reset() and anonymous rotations.
 *     If present, the session belongs to that customer regardless of
 *     which anonymous_id the SDK happens to be using right now.
 *
 *   - `anonymous_id` is the SDK's polaris-side persistent identifier.
 *     It rotates on explicit reset() but is stable across page loads
 *     and across SDK session_id rotations.
 *
 *   - `session_id` is the SDK's session hint — it ALREADY rotates after
 *     30 minutes of inactivity. The processor's own session_id is
 *     independent (deterministic from `occurred_at`), but if no other
 *     identifier is available we use the SDK's session_id as the key.
 */
export const PRIMARY_IDENTIFIER_KINDS = ["customer_id", "anonymous_id", "session_id"] as const;
export type PrimaryIdentifierKind = (typeof PRIMARY_IDENTIFIER_KINDS)[number];

/**
 * Composite identifier the sessionizer keys sessions on. Mirrors the
 * `session.started` / `session.ended` property payloads.
 */
export interface PrimaryIdentifier {
  readonly kind: PrimaryIdentifierKind;
  readonly value: string;
}

/**
 * Resolve the primary identifier the sessionizer keys on. Returns
 * `undefined` when none of the recognised identifiers is present — the
 * runtime drops such events (no session affinity to track).
 */
export function resolvePrimaryIdentifier(
  identity: RawEventIdentity,
): PrimaryIdentifier | undefined {
  for (const kind of PRIMARY_IDENTIFIER_KINDS) {
    const value = readIdentityField(identity, kind);
    if (value !== undefined) return { kind, value };
  }
  return undefined;
}

function readIdentityField(
  identity: RawEventIdentity,
  kind: PrimaryIdentifierKind,
): string | undefined {
  const value = (identity as unknown as Record<string, unknown>)[kind];
  if (typeof value !== "string") return undefined;
  if (value.length === 0) return undefined;
  return value;
}

/**
 * Compose the canonical store key for an active session window. Format:
 * `<project_id>::<environment>::<kind>:<value>`. The kind/value pair is
 * `${kind}:${value}` to disambiguate, e.g., a `customer_id:cus_X` from
 * an `anonymous_id:cus_X` that happens to share the literal value.
 */
export function buildSessionStoreKey(input: {
  readonly project_id: string;
  readonly environment: string;
  readonly primary: PrimaryIdentifier;
}): string {
  return `${input.project_id}::${input.environment}::${input.primary.kind}:${input.primary.value}`;
}

/**
 * Deterministic session_id derivation. The hash domain-separates
 * sessionizer v1 from any future processor that might want a similar
 * derivation. Replays of the same `raw.events` slice produce the same
 * `session_id` byte-for-byte.
 *
 * The output is `sess_<32-hex-chars>` (128 bits of the SHA-256 digest).
 * Truncating to 128 bits keeps the wire payload short while keeping
 * collision risk negligible at the scale Polaris targets.
 */
export function deriveSessionId(input: {
  readonly primary: PrimaryIdentifier;
  /** ISO 8601 UTC start of the session window. */
  readonly started_at: string;
}): string {
  const material = `polaris/sessionizer/v1/${input.primary.kind}:${input.primary.value}/${input.started_at}`;
  const digest = createHash("sha256").update(material, "utf8").digest("hex");
  return `sess_${digest.slice(0, 32)}`;
}

/**
 * Parse the canonical `occurred_at` ISO timestamp as Unix milliseconds.
 * The function is strict: invalid input throws so the runtime classifies
 * the failure through `classifyError` rather than silently dropping the
 * event.
 */
export function parseOccurredAtMs(occurred_at: string): number {
  const ms = Date.parse(occurred_at);
  if (Number.isNaN(ms)) {
    throw new Error(`sessionizer: invalid occurred_at "${occurred_at}"`);
  }
  return ms;
}

/**
 * Decision returned by the pure transform. The runtime interprets:
 *
 *   - `start`         — open a new session for this key; emit `session.started`.
 *   - `continue`      — same active session; no emission. Caller updates the
 *                       store's `last_seen_at` and `event_count`.
 *   - `expire_and_start` — the previous session ended by inactivity. Emit
 *                          `session.ended` for the prior session AND
 *                          `session.started` for the new one. The end
 *                          event's `ended_at` is anchored to the boundary
 *                          (`last_seen_at + inactivity_seconds`).
 *   - `drop`          — no usable primary identifier; the runtime drops
 *                       the event silently.
 */
export type SessionDecision =
  | { readonly kind: "drop" }
  | {
      readonly kind: "start";
      readonly primary: PrimaryIdentifier;
      readonly session_id: string;
      readonly started_at: string;
      readonly store_key: string;
    }
  | {
      readonly kind: "continue";
      readonly primary: PrimaryIdentifier;
      readonly session_id: string;
      readonly started_at: string;
      readonly store_key: string;
    }
  | {
      readonly kind: "expire_and_start";
      readonly primary: PrimaryIdentifier;
      readonly store_key: string;
      readonly ended: {
        readonly session_id: string;
        readonly started_at: string;
        readonly ended_at: string;
        readonly last_seen_at: string;
        readonly event_count: number;
      };
      readonly started: {
        readonly session_id: string;
        readonly started_at: string;
      };
    };

/** Shape of an active session record in the in-memory store. */
export interface SessionRecord {
  readonly session_id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly primary_identifier_kind: PrimaryIdentifierKind;
  readonly primary_identifier_value: string;
  readonly started_at: string;
  readonly last_seen_at: string;
  readonly event_count: number;
  readonly source_event_id: string;
}

/**
 * Apply the v1 session-window rule to a raw event given the prior state
 * for the same key (or `undefined` when no active session exists).
 *
 * `inactivity_seconds` is the semantic boundary value. The runtime
 * reads it from the manifest and passes it in — defaulting to
 * `DEFAULT_INACTIVITY_SECONDS` keeps tests deterministic.
 */
export function decideSession(input: {
  readonly raw: RawEventEnvelope;
  readonly prior: SessionRecord | undefined;
  readonly inactivity_seconds?: number;
}): SessionDecision {
  const inactivitySeconds = input.inactivity_seconds ?? DEFAULT_INACTIVITY_SECONDS;
  const primary = resolvePrimaryIdentifier(input.raw.identity);
  if (primary === undefined) return { kind: "drop" };

  const storeKey = buildSessionStoreKey({
    project_id: input.raw.project_id,
    environment: input.raw.environment,
    primary,
  });

  // Fresh session — no prior, or prior is for a stale (project, env)
  // composition. The store layer guarantees prior matches the key, but
  // we re-check defensively because the runtime passes prior through
  // unchanged.
  if (input.prior === undefined) {
    const sessionId = deriveSessionId({ primary, started_at: input.raw.occurred_at });
    return {
      kind: "start",
      primary,
      session_id: sessionId,
      started_at: input.raw.occurred_at,
      store_key: storeKey,
    };
  }

  // Replay safety: if the inbound event is OLDER than the prior session's
  // start, the store has been seeded out of order. Treat the event as a
  // fresh start so the deterministic session_id derivation still aligns
  // with whatever timeline this slice represents. The store layer is
  // responsible for keeping its records monotonic; this branch is a
  // safety net.
  const occurredMs = parseOccurredAtMs(input.raw.occurred_at);
  const priorLastMs = parseOccurredAtMs(input.prior.last_seen_at);
  const priorStartMs = parseOccurredAtMs(input.prior.started_at);
  if (occurredMs < priorStartMs) {
    const sessionId = deriveSessionId({ primary, started_at: input.raw.occurred_at });
    return {
      kind: "start",
      primary,
      session_id: sessionId,
      started_at: input.raw.occurred_at,
      store_key: storeKey,
    };
  }

  const inactivityMs = inactivitySeconds * 1000;
  const boundaryMs = priorLastMs + inactivityMs;

  if (occurredMs >= boundaryMs) {
    // Prior session expired. End it on the boundary; start a new one
    // anchored to the current event.
    const endedAtIso = new Date(boundaryMs).toISOString();
    const newSessionId = deriveSessionId({ primary, started_at: input.raw.occurred_at });
    return {
      kind: "expire_and_start",
      primary,
      store_key: storeKey,
      ended: {
        session_id: input.prior.session_id,
        started_at: input.prior.started_at,
        ended_at: endedAtIso,
        last_seen_at: input.prior.last_seen_at,
        event_count: input.prior.event_count,
      },
      started: {
        session_id: newSessionId,
        started_at: input.raw.occurred_at,
      },
    };
  }

  // Still inside the window — continue the same session. No emission.
  return {
    kind: "continue",
    primary,
    session_id: input.prior.session_id,
    started_at: input.prior.started_at,
    store_key: storeKey,
  };
}
